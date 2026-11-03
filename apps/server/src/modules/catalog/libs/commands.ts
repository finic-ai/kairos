import { readCommandInputs, commandState } from "@kairos/core";
import { z } from "zod";
import type { ActivitySource } from "../../../db/schema";
import type { Webhooks } from "../../../context";
import { invalid, notFound } from "../../../platform/error";
import type { Repositories } from "../../../repositories";
import { ActivitiesService } from "../../../services/activity.service";
import { CaseActivityService, CasesService } from "../../../services/case.service";
import { EntitiesService } from "../../../services/entities.service";
import { WebhookDeliveriesService } from "../../../services/webhook_delivery.service";
import { caseDetail } from "../../cases/service";
import { commandIssued } from "../../webhooks/types";

export const issueCommandBody = z
  .object({
    inputs: z.record(z.string(), z.unknown()).optional(),
    case_id: z.string().trim().min(1).optional(),
    by: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

type Scope = { workspaceId: string; environmentId: string };

export interface IssueCommand {
  type: string;
  id: string;
  key: string;
  inputs?: Record<string, unknown>;
  caseId?: string;
  /** The member's email, the key's name, or the `by` of a key. */
  actor: string;
  userId?: string;
  apiKeyId?: string;
  source: ActivitySource;
  ip?: string | null;
  userAgent?: string | null;
}

const pageOf = (caseId: string | undefined) => (caseId ? "case" : "entity");

/**
 * Issue one command. The definition lives on the entity type. The click is an activity row, and a
 * case click is also on the case. The webhook uses the existing outbound pipe.
 */
export async function issueCommand(
  repos: Pick<Repositories, "db" | "transaction">,
  scope: Scope,
  input: IssueCommand,
  now: Date,
  webhooks?: Webhooks,
) {
  const definition = await new EntitiesService(repos.db, scope).findByType(input.type);
  const command = definition?.commands?.find((c) => c.key === input.key);
  if (!command) throw notFound(`No command "${input.key}" on ${input.type}`);
  const visibility = command.visibility ?? "all";
  if (visibility !== "all" && visibility !== pageOf(input.caseId))
    throw invalid(`"${command.label}" is not on this page`);
  const { inputs, problems } = readCommandInputs(command, input.inputs);
  if (problems.length) throw invalid(problems.join("; "));

  const onCase = input.caseId ? await caseFor(repos.db, scope, input.caseId, input.type, input.id, input.userId) : null;

  const done = await repos.transaction(async (tx) => {
    const activity = await new ActivitiesService(tx.db, { workspaceId: scope.workspaceId }).record(
      {
        environmentId: scope.environmentId,
        source: input.source,
        userId: input.userId ?? null,
        apiKeyId: input.apiKeyId ?? null,
        action: "command.issued",
        resourceType: "entity",
        resourceId: `${input.type}:${input.id}`,
        details: {
          command: command.key,
          label: command.label,
          inputs,
          subject: { type: input.type, id: input.id },
          by: input.actor,
          ...(onCase ? { case_id: onCase.caseId, queue_id: onCase.queueId } : {}),
        },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      now,
    );
    if (onCase) {
      await new CaseActivityService(tx.db, scope).create(
        {
          caseId: onCase.caseId,
          type: "command",
          actor: input.actor,
          payload: {
            activity_id: activity.id,
            command: command.key,
            label: command.label,
            subject: { type: input.type, id: input.id },
          },
        },
        now,
      );
      await new CasesService(tx.db, scope).update(onCase.caseId, { lastActivity: now }, now);
    }
    const queued = await tx.outbox.enqueue(
      scope.workspaceId,
      scope.environmentId,
      commandIssued({
        command_id: activity.id,
        command: command.key,
        subject: { type: input.type, id: input.id },
        inputs,
        by: input.actor,
        ...(onCase ? { case_id: onCase.caseId, queue_id: onCase.queueId } : {}),
      }),
      now,
    );
    return { id: activity.id, queued };
  });
  if (done.queued > 0) webhooks?.worker?.wake();
  return { id: done.id, command: command.key, label: command.label, inputs, queued: done.queued };
}

async function caseFor(
  db: Repositories["db"],
  scope: Scope,
  caseId: string,
  type: string,
  id: string,
  viewer: string | undefined,
) {
  const detail = await caseDetail(db, scope, caseId, viewer);
  const holds =
    (detail.target.type === type && detail.target.id === id) ||
    detail.items.some((item) => item.kind === "entity" && item.type === type && item.id === id);
  if (!holds) throw invalid(`This case does not hold ${type} ${id}`);
  return { caseId, queueId: detail.queue.id };
}

/** Commands issued on one entity, newest first, each with what the endpoints answered. */
export async function listCommands(db: Repositories["db"], scope: Scope, type: string, id: string) {
  const rows = await new ActivitiesService(db, { workspaceId: scope.workspaceId }).findMany({
    where: {
      environmentId: scope.environmentId,
      action: "command.issued",
      resourceType: "entity",
      resourceId: `${type}:${id}`,
    },
    orderBy: { created: "desc", id: "desc" },
    limit: 20,
  });
  const deliveries = new WebhookDeliveriesService(db, scope);
  return Promise.all(
    rows.map(async (row) => {
      const sent = await deliveries.listAbout(`activity:${row.id}`);
      const details = row.details;
      return {
        id: row.id,
        command: text(details.command),
        label: text(details.label),
        inputs: details.inputs ?? {},
        case_id: text(details.case_id),
        by: text(details.by) ?? null,
        created: row.created.toISOString(),
        state: commandState(sent.map((d) => ({ status: d.status, responseStatus: d.responseStatus }))),
        answers: sent.map((d) => ({
          webhook: d.webhook?.name ?? d.webhookId,
          status: d.responseStatus,
          body: d.responseBody,
          state: d.status,
        })),
      };
    }),
  );
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
