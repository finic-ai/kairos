import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  askQuestionProblems,
  MAX_ASK_DATA_BYTES,
  type ActionDefinition,
  type AskQuestion,
  type CaseCategory,
  type CasePriority,
  type CaseStatus,
  type Decider,
} from "@kairos/core";
import type { Repositories } from "../../../repositories";
import { ActionsService } from "../../../services/action.service";
import { DecisionsService } from "../../../services/decision.service";
import { EntitiesService } from "../../../services/entities.service";
import { EventsService } from "../../../services/event.service";
import { ObjectsService } from "../../../services/object.service";
import { addLabel, upsertObject } from "../../catalog/service";
import { AppError } from "../../../platform/error";
import { askModel, assessDecision, resolveDecision, runDecision } from "../../decisions/service";
import { caseRecord, createCaseFromWorkflow, resolveCaseFromWorkflow, searchCases } from "../../cases/service";
import { addItems, removeItems } from "../../lists";
import { scoreFeatures, type ScoreResult, type StepScore } from "../../models";
import { evaluateRef } from "../../rulesets";
import { guardedLookup, urlProblem } from "../../webhooks/libs";
import { ExpressionError, resolveValue, type Variables } from "./expressions";
import { readFeatures } from "./models";
import { NO_SECRETS, usesSecrets } from "./validate";
import type { WorkflowStepDef } from "../types";

/** A step that cannot be done. `retryable` says whether another attempt can succeed. */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface StepContext {
  repos: Repositories;
  decider: Decider;
  workspaceId: string;
  environmentId: string;
  run: { id: string; test: boolean };
  /** The path of the step, such as "blocked.notify" or "each[2].check": its idempotency key. */
  path: string;
  /** In a test run, the step paths that may act for real. All others only show what they would do. */
  liveSteps: ReadonlySet<string>;
  /** In a test run, sample outputs by step id for the steps that only show what they would do. */
  mockOutputs?: Readonly<Record<string, unknown>>;
  allowPrivate: boolean;
  now: Date;
  /** Told when a decide step saves a decision, so its webhooks go out. */
  wake?: () => void;
  /** Told what an "Ask the model" step was told, with the model's whole answer. */
  onAssess?: (assessment: unknown) => void;
  onScore?: (score: StepScore) => void;
  /** What a model step showed the model. The run log keeps it beside the output, where later steps do not read it. */
  onRead?: (read: unknown) => void;
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value) throw new StepFailure(`${field}: a text value is needed`);
  return value;
};
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StepFailure(`${field}: an object is needed`);
  return value as Record<string, unknown>;
};
const limit = (value: unknown) => Math.min(200, Math.max(1, Number(value ?? 50) || 50));

/** Run one step that acts (not a condition, loop, filter or delay) and return its output. */
export async function runStep(step: WorkflowStepDef, vars: Variables, ctx: StepContext): Promise<unknown> {
  switch (step.type) {
    case "http":
      return httpStep(step, vars, ctx);
    case "decide":
      return decideStep(step, vars, ctx);
    case "assess":
      return assessStep(step, vars, ctx);
    case "ask":
      return askStep(step, vars, ctx);
    case "score":
      return scoreStep(step, vars, ctx);
    case "record.get":
      return recordGet(step, vars, ctx);
    case "record.search":
      return recordSearch(step, vars, ctx);
    case "record.create":
      return recordCreate(step, vars, ctx);
    case "record.update":
      return recordUpdate(step, vars, ctx);
    case "case.create":
      return caseCreate(step, vars, ctx);
    case "case.resolve":
      return caseResolve(step, vars, ctx);
    case "ruleset":
      return rulesetStep(step, vars, ctx);
    case "list.add":
    case "list.remove":
      return listStep(step, vars, ctx);
    default:
      throw new StepFailure(`the runner does not run a "${step.type}" step here`);
  }
}

/** A live step is named by its path, or by its id: a step in a loop has a path for each item. */
const isLive = (ctx: StepContext) => ctx.liveSteps.has(ctx.path) || ctx.liveSteps.has(ctx.path.split(".").at(-1)!);

/**
 * In a test run, what a step that is not live gives instead of acting. A sample output given for
 * it comes too, so the steps after it can read what they would read in a real run.
 */
const testOutput = (ctx: StepContext, would: Record<string, unknown>) => {
  if (!ctx.run.test || isLive(ctx)) return null;
  const mock = ctx.mockOutputs?.[ctx.path.split(".").at(-1)!];
  return mock && typeof mock === "object" && !Array.isArray(mock)
    ? { ...(mock as Record<string, unknown>), test: true, would }
    : { test: true, would };
};

const fields = (step: WorkflowStepDef, vars: Variables, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, resolveValue(step[n], vars)]));

async function httpStep(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  if (usesSecrets(step)) throw new StepFailure(NO_SECRETS);
  const method = String(step.method ?? "GET").toUpperCase();
  const url = text(resolveValue(step.url, vars), "url");
  const headers = (resolveValue(step.headers ?? {}, vars) ?? {}) as Record<string, string>;
  const query = (resolveValue(step.query ?? {}, vars) ?? {}) as Record<string, unknown>;
  const body = step.body === undefined ? undefined : resolveValue(step.body, vars);
  const would = testOutput(ctx, { method, url });
  if (would) return would;

  const target = new URL(url);
  for (const [k, v] of Object.entries(query)) target.searchParams.set(k, String(v));
  const problem = urlProblem(target.toString(), ctx.allowPrivate);
  if (problem) throw new StepFailure(`the URL ${problem}`);
  const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const json =
    body !== undefined &&
    typeof body !== "string" &&
    !Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
  const timeoutMs = Math.min(15_000, Math.max(1_000, Number(step.timeout_seconds ?? 10) * 1000));
  const result = await sendHttp(
    target,
    method,
    {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...headers,
      "Idempotency-Key": `${ctx.run.id}:${ctx.path}`,
    },
    payload,
    timeoutMs,
    ctx.allowPrivate,
  );
  if (result.problem) throw new StepFailure(result.problem, true);
  const listed = Array.isArray(step.success_status) ? (step.success_status as number[]) : null;
  const success = listed ? listed.includes(result.status) : result.status >= 200 && result.status < 400;
  if (!success) throw new StepFailure(`answered ${result.status}`, result.status >= 500 || result.status === 429);
  let parsed: unknown = result.body;
  try {
    parsed = JSON.parse(result.body);
  } catch {}
  return { status: result.status, headers: result.headers, body: parsed };
}

interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  problem?: string;
}

function sendHttp(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  allowPrivate: boolean,
): Promise<HttpResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: HttpResult) => (settled ? undefined : ((settled = true), resolve(r)));
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = client(
      url,
      {
        method,
        headers: { ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
        lookup: guardedLookup(allowPrivate) as never,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 256 * 1024) chunks.push(chunk);
        });
        res.on("end", () =>
          finish({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
            ),
            body: Buffer.concat(chunks)
              .toString("utf8")
              .slice(0, 256 * 1024),
          }),
        );
      },
    );
    req.on(
      "timeout",
      () => (
        req.destroy(),
        finish({ status: 0, headers: {}, body: "", problem: `no answer within ${timeoutMs / 1000} s` })
      ),
    );
    req.on("error", (cause) => finish({ status: 0, headers: {}, body: "", problem: (cause as Error).message }));
    if (body) req.write(body);
    req.end();
  });
}

async function findAction(ctx: StepContext, ref: string): Promise<ActionDefinition> {
  const actions = new ActionsService(ctx.repos.db, { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId });
  const pinned = /^(.*)@(\d+)$/.exec(ref);
  const action = pinned ? await actions.findVersion(pinned[1]!, Number(pinned[2])) : await actions.findLatest(ref);
  if (!action) throw new StepFailure(`No action "${ref}"`);
  return action;
}

async function decideStep(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const scope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId };
  const stepKey = `${ctx.run.id}:${ctx.path}`;
  const decisions = new DecisionsService(ctx.repos.db, scope);
  const earlier = await decisions.findByWorkflowStep(stepKey);
  if (earlier) return { ...(earlier.decision as Record<string, unknown>), decision_id: earlier.id };

  const f = fields(step, vars, ["action", "entities", "properties", "ts", "session"]);
  const ref = text(f.action, "action");
  const action = await findAction(ctx, ref);
  const entities = record(f.entities, "entities") as Record<string, string>;
  const properties = (f.properties ?? {}) as Record<string, unknown>;
  const would = testOutput(ctx, { action: ref, entities, properties });
  if (would) return would;

  // The decision keeps the event of the trigger, unless a decision already has that event.
  const event = vars.event as { id?: string; session?: string } | undefined;
  let eventId: string | undefined;
  if (event?.id && step.event_id !== false) {
    const prior = await decisions.findByEvent(event.id);
    if (!prior) eventId = event.id;
  }
  const asOf = typeof f.ts === "string" ? new Date(f.ts) : undefined;
  let result: Awaited<ReturnType<typeof runDecision>>;
  try {
    // The step key is written with the decision, so a retry after a crash finds it and does not decide again.
    result = await runDecision(
      ctx.repos,
      ctx.decider,
      ctx.workspaceId,
      ctx.environmentId,
      {
        action,
        entities,
        properties,
        ...(eventId ? { eventId } : {}),
        session: typeof f.session === "string" ? f.session : event?.session,
        metadata: { workflow_run_id: ctx.run.id, workflow_step_key: stepKey },
      },
      asOf ?? ctx.now,
      ctx.now,
      ctx.wake && !asOf ? { wake: ctx.wake, now: ctx.now } : undefined,
      { allowPrivate: ctx.allowPrivate, ...(ctx.wake ? { wake: ctx.wake } : {}), live: !asOf },
    );
  } catch (cause) {
    // Another attempt of this step saved its decision first (the unique index on the step key).
    const saved = await decisions.findByWorkflowStep(stepKey);
    if (saved) return { ...(saved.decision as Record<string, unknown>), decision_id: saved.id };
    throw new StepFailure((cause as Error).message, true);
  }
  return { ...result };
}

/**
 * What the model and the action's policy say, with nothing saved. In a decision workflow, the
 * action, the entities, the properties and the session are the decision request's, unless the
 * step names others.
 */
async function assessStep(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const trigger = (vars.trigger ?? {}) as {
    action?: string;
    entities?: unknown;
    properties?: unknown;
    session?: unknown;
    event_id?: unknown;
    ts?: unknown;
  };
  const f = fields(step, vars, ["action", "entities", "properties", "session"]);
  const ref = typeof f.action === "string" && f.action ? f.action : trigger.action;
  if (!ref) throw new StepFailure("action: the action whose model to ask");
  const action = await findAction(ctx, ref);
  const entities = record(f.entities ?? trigger.entities, "entities") as Record<string, string>;
  if (!entities[action.subject])
    throw new StepFailure(`entities.${action.subject}: action "${action.name}" decides about a ${action.subject}`);
  const properties = (f.properties ?? trigger.properties ?? {}) as Record<string, unknown>;
  const session =
    typeof f.session === "string" ? f.session : typeof trigger.session === "string" ? trigger.session : undefined;
  // The decision request's own event is the pending action; it is not in the history the model reads.
  const sameRequest = !f.entities && trigger.action === ref;
  const asOf = typeof trigger.ts === "string" ? new Date(trigger.ts) : ctx.now;
  let assessment: Awaited<ReturnType<typeof assessDecision>>;
  try {
    assessment = await assessDecision(
      ctx.repos,
      ctx.decider,
      ctx.workspaceId,
      ctx.environmentId,
      {
        action,
        entities,
        properties,
        ...(session ? { session } : {}),
        ...(sameRequest && typeof trigger.event_id === "string" ? { eventId: trigger.event_id } : {}),
      },
      asOf,
      typeof step.model === "string" ? step.model : undefined,
    );
  } catch (cause) {
    throw new StepFailure((cause as Error).message, true);
  }
  ctx.onAssess?.(assessment);
  const raw = assessment.raw as { model?: string; answers?: unknown };
  ctx.onRead?.({ model: raw.model, context: assessment.context, answers: raw.answers });
  return assessment.decision;
}

async function scoreStep(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const mock = ctx.run.test ? ctx.mockOutputs?.[step.id] : undefined;
  if (mock !== undefined) return mock;
  if (typeof step.model !== "string") throw new StepFailure("model: the model to score with");
  const values = readFeatures((step.features ?? {}) as Record<string, unknown>, vars);
  let result: ScoreResult;
  try {
    result = await scoreFeatures(
      ctx.repos.db,
      { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId },
      step.model,
      values,
    );
  } catch (cause) {
    // A model that is not there fails again: only a database error is worth a retry.
    throw new StepFailure((cause as Error).message, !(cause instanceof AppError));
  }
  ctx.onScore?.({ step: step.id, ...result });
  return result;
}

/**
 * Ask the model the step's questions, about an entity's history, the step's data, or both. The
 * output has each answer by its question's key, and the tokens it read. A test run with a sample
 * output for the step uses it, and asks nothing.
 */
async function askStep(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const mock = ctx.run.test ? ctx.mockOutputs?.[ctx.path.split(".").at(-1)!] : undefined;
  if (mock !== undefined) return mock;
  const f = fields(step, vars, ["entity", "data", "questions"]);
  const about = f.entity === undefined ? undefined : record(f.entity, "entity");
  const entity = about && { type: text(about.type, "entity.type"), id: text(String(about.id ?? ""), "entity.id") };
  const data = f.data === undefined ? undefined : record(f.data, "data");
  if (data && Buffer.byteLength(JSON.stringify(data)) > MAX_ASK_DATA_BYTES)
    throw new StepFailure(`data: the model reads at most ${MAX_ASK_DATA_BYTES / 1024} KB`);
  // The question text can hold templates, so the questions are checked again once they are filled in.
  const problems = askQuestionProblems(f.questions, "questions");
  if (problems.length) throw new StepFailure(problems.join("; "));
  const trigger = (vars.trigger ?? {}) as { ts?: unknown };
  // As the assess step does: a decision as of a past moment must not read the history after it.
  const asOf = typeof trigger.ts === "string" ? new Date(trigger.ts) : ctx.now;
  try {
    const { answers, input_tokens, context, model } = await askModel(
      ctx.repos,
      ctx.decider,
      ctx.workspaceId,
      ctx.environmentId,
      {
        ...(entity ? { entity } : {}),
        ...(data ? { data } : {}),
        questions: f.questions as Record<string, AskQuestion>,
        ...(typeof step.model === "string" ? { model: step.model } : {}),
      },
      asOf,
    );
    ctx.onRead?.({ model, context, questions: f.questions });
    return { ...answers, input_tokens };
  } catch (cause) {
    throw new StepFailure((cause as Error).message, true);
  }
}

async function recordGet(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const scope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId };
  const f = fields(step, vars, ["record", "record_id", "entity"]);
  const id = text(f.record_id, "record_id");
  switch (f.record) {
    case "event": {
      const found =
        (await new EventsService(ctx.repos.db, scope).findByExternalId(id)) ??
        (await new EventsService(ctx.repos.db, scope).findById(id).then((r) =>
          r
            ? {
                id: r.externalId,
                type: r.type,
                ts: r.ts.toISOString(),
                entities: r.entities,
                properties: r.properties,
                ...(r.universalId ? { universal_id: r.universalId } : {}),
                ...(r.status ? { status: r.status } : {}),
                ...(r.sessionId ? { session: r.sessionId } : {}),
              }
            : null,
        ));
      if (!found) throw new StepFailure(`No event "${id}"`);
      return found;
    }
    case "object": {
      const type = text(f.entity, "entity");
      const found = await new ObjectsService(ctx.repos.db, scope).findByEntity({ type, id });
      if (!found) throw new StepFailure(`No ${type} "${id}"`);
      return found;
    }
    case "entity_type": {
      const found = await new EntitiesService(ctx.repos.db, scope).findByType(id);
      if (!found) throw new StepFailure(`No entity type "${id}"`);
      return found;
    }
    case "decision": {
      const found = await new DecisionsService(ctx.repos.db, scope).findRecord(id);
      if (!found) throw new StepFailure(`No decision "${id}"`);
      return found;
    }
    case "case": {
      try {
        return await caseRecord(ctx.repos.db, scope, id);
      } catch (cause) {
        throw new StepFailure((cause as Error).message);
      }
    }
    default:
      throw new StepFailure(`record.get does not read "${String(f.record)}"`);
  }
}

async function recordSearch(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const scope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId };
  const f = fields(step, vars, [
    "record",
    "entity",
    "record_id",
    "types",
    "q",
    "label",
    "outcome",
    "action",
    "limit",
    "queue",
    "status",
    "priority",
    "assignee",
    "item_type",
    "item_id",
    "created_after",
  ]);
  const max = limit(f.limit);
  switch (f.record) {
    case "case": {
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      const after = str(f.created_after);
      return searchCases(ctx.repos.db, scope, {
        limit: max,
        ...(str(f.queue) ? { queueId: str(f.queue) } : {}),
        ...(str(f.status) ? { status: str(f.status) as CaseStatus | "unresolved" } : {}),
        ...(str(f.priority) ? { priority: str(f.priority) as CasePriority } : {}),
        ...(str(f.assignee) ? { assignee: str(f.assignee) } : {}),
        ...(str(f.entity) && str(f.record_id) ? { target: { type: str(f.entity)!, id: str(f.record_id)! } } : {}),
        ...(str(f.item_type) && str(f.item_id) ? { item: { type: str(f.item_type)!, id: str(f.item_id)! } } : {}),
        ...(after && !Number.isNaN(Date.parse(after)) ? { createdAfter: new Date(after) } : {}),
      });
    }
    case "event": {
      const types = Array.isArray(f.types) ? (f.types as string[]) : undefined;
      if (typeof f.entity === "string" && typeof f.record_id === "string" && f.record_id) {
        const about = await ctx.repos.events.timeline(
          ctx.workspaceId,
          ctx.environmentId,
          { type: f.entity, id: f.record_id },
          200,
          ctx.now.toISOString(),
        );
        return about
          .filter((e) => !types?.length || types.includes(e.type))
          .reverse()
          .slice(0, max)
          .map(({ metadata: _metadata, ...e }) => e);
      }
      const rows = await new EventsService(ctx.repos.db, scope).findMany({
        ...(types?.length ? { where: { type: { in: types } } } : {}),
        orderBy: { ts: "desc" },
        limit: max,
      });
      return rows.map((r) => ({
        id: r.externalId,
        type: r.type,
        ts: r.ts.toISOString(),
        entities: r.entities,
        properties: r.properties,
        ...(r.status ? { status: r.status } : {}),
      }));
    }
    case "object": {
      const type = text(f.entity, "entity");
      return ctx.repos.entities.listEntities(ctx.workspaceId, ctx.environmentId, {
        type,
        ...(typeof f.q === "string" ? { q: f.q } : {}),
        ...(typeof f.label === "string" ? { label: f.label } : {}),
        ...(typeof f.outcome === "string" ? { outcome: f.outcome } : {}),
        limit: max,
        offset: 0,
      });
    }
    case "decision": {
      return new DecisionsService(ctx.repos.db, scope).listSummaries({
        limit: max,
        offset: 0,
        ...(typeof f.action === "string" ? { action: f.action } : {}),
        ...(typeof f.outcome === "string" ? { outcome: f.outcome } : {}),
        ...(typeof f.entity === "string" && typeof f.record_id === "string" && f.record_id
          ? { subject: { type: f.entity, id: f.record_id } }
          : {}),
      });
    }
    case "entity_type": {
      return ctx.repos.entities.entityTypes(ctx.workspaceId, ctx.environmentId);
    }
    default:
      throw new StepFailure(`record.search does not search "${String(f.record)}"`);
  }
}

async function recordCreate(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const scope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId };
  const f = fields(step, vars, [
    "record",
    "entity",
    "record_id",
    "event_type",
    "entities",
    "properties",
    "ts",
    "status",
    "session",
    "definition",
  ]);
  switch (f.record) {
    case "event": {
      const type = text(f.event_type, "event_type");
      const id =
        typeof f.record_id === "string" && f.record_id
          ? f.record_id
          : `wf_${ctx.run.id}_${ctx.path.replaceAll(/[^A-Za-z0-9]/g, "_")}`;
      const event = {
        id,
        type,
        ts: typeof f.ts === "string" ? f.ts : ctx.now.toISOString(),
        entities: record(f.entities, "entities") as Record<string, string>,
        properties: (f.properties ?? {}) as Record<string, unknown>,
        ...(typeof f.status === "string" ? { status: f.status } : {}),
        ...(typeof f.session === "string" ? { session: f.session } : {}),
        metadata: { workflow_run_id: ctx.run.id },
      };
      const would = testOutput(ctx, { event });
      if (would) return would;
      const result = await ctx.repos.events.insertEvents(
        ctx.workspaceId,
        ctx.environmentId,
        [event],
        ctx.now.toISOString(),
        "workflow",
      );
      return { id, accepted: result.accepted, duplicates: result.duplicates };
    }
    case "object": {
      const type = text(f.entity, "entity");
      const id = text(f.record_id, "record_id");
      const properties = record(f.properties ?? {}, "properties");
      const would = testOutput(ctx, { object: { type, id, properties } });
      if (would) return would;
      return upsertObject(
        ctx.repos.db,
        ctx.workspaceId,
        ctx.environmentId,
        { type, id },
        properties,
        ctx.now.toISOString(),
        [],
        ctx.run.id,
      );
    }
    case "entity_type": {
      const type = text(f.entity, "entity");
      const definition = record(f.definition, "definition");
      const would = testOutput(ctx, { entity_type: { type, definition } });
      if (would) return would;
      return new EntitiesService(ctx.repos.db, scope).save({ ...definition, type } as never, ctx.now);
    }
    default:
      throw new StepFailure(`record.create does not create "${String(f.record)}"`);
  }
}

async function recordUpdate(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const scope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId };
  const f = fields(step, vars, [
    "record",
    "entity",
    "record_id",
    "properties",
    "unset",
    "add_label",
    "resolution",
    "definition",
  ]);
  switch (f.record) {
    case "object": {
      const type = text(f.entity, "entity");
      const id = text(f.record_id, "record_id");
      const entity = { type, id };
      const would = testOutput(ctx, { object: entity, properties: f.properties, add_label: f.add_label });
      if (would) return would;
      let out: unknown = null;
      if (f.properties || f.unset)
        out = await upsertObject(
          ctx.repos.db,
          ctx.workspaceId,
          ctx.environmentId,
          entity,
          record(f.properties ?? {}, "properties"),
          ctx.now.toISOString(),
          Array.isArray(f.unset) ? (f.unset as string[]) : [],
          ctx.run.id,
        );
      if (typeof f.add_label === "string")
        await addLabel(
          ctx.repos,
          ctx.workspaceId,
          ctx.environmentId,
          entity,
          {
            label: f.add_label,
            ts: ctx.now.toISOString(),
            properties: {},
            metadata: { workflow_run_id: ctx.run.id },
          },
          ctx.now,
          true,
        );
      return out ?? { ...entity, labelled: f.add_label ?? undefined };
    }
    case "decision": {
      const id = text(f.record_id, "record_id");
      const resolution = record(f.resolution, "resolution") as { outcome: "approve" | "block"; note?: string };
      const would = testOutput(ctx, { decision: id, resolution });
      if (would) return would;
      const by = typeof step.by === "string" ? step.by : "workflow";
      // As a person's resolution is: the webhooks and the record triggers see it.
      const found = await resolveDecision(
        ctx.repos,
        ctx.workspaceId,
        ctx.environmentId,
        id,
        {
          outcome: resolution.outcome,
          ...(resolution.note ? { note: resolution.note } : {}),
          by,
          at: ctx.now.toISOString(),
        },
        ctx.now,
        ctx.run.id,
      );
      if (!found) throw new StepFailure(`No decision "${id}"`);
      if (found.queued > 0) ctx.wake?.();
      return found.record;
    }
    case "entity_type": {
      const type = text(f.entity, "entity");
      const definition = record(f.definition, "definition");
      const would = testOutput(ctx, { entity_type: { type, definition } });
      if (would) return would;
      return new EntitiesService(ctx.repos.db, scope).save({ ...definition, type } as never, ctx.now);
    }
    default:
      throw new StepFailure(`record.update does not update "${String(f.record)}"`);
  }
}

const workflowOf = (vars: Variables) => {
  const run = vars.run as { workflow?: string; version?: number } | undefined;
  return run?.workflow ? `${run.workflow}${run.version ? `@${run.version}` : ""}` : "workflow";
};
const ids = (value: unknown) =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .filter((v) => typeof v === "string" || typeof v === "number")
    .map(String);

/** A refusal of the case service is not fixed by another attempt: a missing queue stays missing. */
const caseFailure = (cause: unknown) => new StepFailure((cause as Error).message, !(cause instanceof AppError));

async function caseCreate(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const f = fields(step, vars, ["queue", "entity", "correlation", "reason", "priority", "mode", "links"]);
  const queue = text(f.queue, "queue");
  const entity = record(f.entity, "entity");
  const target = { type: text(entity.type, "entity.type"), id: text(String(entity.id ?? ""), "entity.id") };
  const priority = (f.priority ?? "normal") as CasePriority;
  const mode = (f.mode ?? "add_or_create") as "add_or_create" | "create";
  const links = (f.links ?? {}) as { decisions?: unknown; events?: unknown; entities?: unknown };
  const decisions = ids(links.decisions);
  const events = ids(links.events);
  // By default the case links the decisions of the run's decide steps, and the event that started the run.
  for (const out of Object.values((vars.steps ?? {}) as Record<string, { output?: { decision_id?: unknown } }>))
    if (typeof out?.output?.decision_id === "string" && !decisions.includes(out.output.decision_id))
      decisions.push(out.output.decision_id);
  const event = vars.event as { id?: string; session?: string } | undefined;
  if (event?.id && !events.includes(event.id)) events.push(event.id);
  const entities = (Array.isArray(links.entities) ? links.entities : [])
    .filter((e): e is { type: string; id: string } => !!e && typeof e === "object" && "type" in e && "id" in e)
    .map((e) => ({ type: String(e.type), id: String(e.id) }));
  const reason = text(f.reason, "reason");

  const would = testOutput(ctx, {
    queue,
    entity: target,
    reason,
    priority,
    mode,
    links: { decisions, events, entities },
  });
  if (would) return would;
  try {
    const { queued, ...out } = await createCaseFromWorkflow(
      ctx.repos,
      { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId },
      {
        queue,
        entity: target,
        ...(typeof f.correlation === "string" || typeof f.correlation === "number"
          ? { correlation: String(f.correlation) }
          : {}),
        reason,
        priority,
        mode,
        links: { decisions, events, entities },
        run: { id: ctx.run.id, path: ctx.path, workflow: workflowOf(vars) },
        ...(event?.id ? { event: { id: event.id, ...(event.session ? { session: event.session } : {}) } } : {}),
      },
      ctx.now,
    );
    if (queued > 0) ctx.wake?.();
    return out;
  } catch (cause) {
    throw caseFailure(cause);
  }
}

async function caseResolve(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const f = fields(step, vars, ["case_id", "category", "note", "apply_to_decisions", "label_target"]);
  const id = text(f.case_id, "case_id");
  const input = {
    category: text(f.category, "category") as CaseCategory,
    ...(typeof f.note === "string" && f.note ? { note: f.note } : {}),
    apply_to_decisions: f.apply_to_decisions === true,
    label_target: f.label_target === true,
  };
  const would = testOutput(ctx, { case_id: id, ...input });
  if (would) return would;
  try {
    const done = await resolveCaseFromWorkflow(
      ctx.repos,
      { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId },
      id,
      input,
      { id: ctx.run.id, path: ctx.path, workflow: workflowOf(vars) },
      ctx.now,
    );
    const { queued, ...out } = done;
    if (queued > 0) ctx.wake?.();
    return out;
  } catch (cause) {
    throw caseFailure(cause);
  }
}

/** A ruleset reads only its input and writes nothing, so it runs for real in a test run too. */
async function rulesetStep(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const ref = text(resolveValue(step.ruleset, vars), "ruleset");
  const input =
    step.input && typeof step.input === "object" && !Array.isArray(step.input)
      ? rulesetInput(step.input as Record<string, unknown>, vars)
      : step.input === undefined
        ? {}
        : record(resolveValue(step.input, vars), "input");
  try {
    return await evaluateRef(
      ctx.repos.db,
      { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId },
      ref,
      input,
    );
  } catch (cause) {
    if (cause instanceof AppError) throw new StepFailure(cause.message);
    throw cause;
  }
}

const NOT_THERE = /^field not found: /;

/**
 * Each input on its own: a template that reads a field the run does not have gives no value, so
 * the ruleset sees a missing input, and refuses it only when it is required.
 */
function rulesetInput(mapping: Record<string, unknown>, vars: Variables): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mapping)) {
    try {
      input[name] = resolveValue(value, vars);
    } catch (cause) {
      if (!(cause instanceof ExpressionError && NOT_THERE.test(cause.message))) throw cause;
    }
  }
  return input;
}

const ITEM_MATCHES = new Set(["exact", "prefix", "suffix", "contains", "word"]);

/** Add an item to a list, or remove one. An item that is there already, or not there, is no failure. */
async function listStep(step: WorkflowStepDef, vars: Variables, ctx: StepContext) {
  const f = fields(step, vars, ["list", "value", "note", "match", "case_sensitive"]);
  const list = text(f.list, "list");
  if (typeof f.value !== "string" && typeof f.value !== "number") throw new StepFailure("value: text or a number");
  const value = f.value;
  const would = testOutput(ctx, { list, value });
  if (would) return would;
  const scope = { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId };
  const run = vars.run as { workflow: string; version: number };
  const by = `workflow:${run.workflow}@${run.version}`;
  try {
    if (step.type === "list.remove") {
      const { removed } = await removeItems(ctx.repos.db, scope, list, [value], by, ctx.now);
      return { list, value: String(value).trim(), removed: removed > 0 };
    }
    const { added } = await addItems(
      ctx.repos.db,
      scope,
      list,
      [
        {
          value,
          ...(typeof f.note === "string" && f.note.trim() ? { note: f.note.trim().slice(0, 500) } : {}),
          ...(typeof f.match === "string" && ITEM_MATCHES.has(f.match) ? { match: f.match as never } : {}),
          ...(typeof f.case_sensitive === "boolean" ? { case_sensitive: f.case_sensitive } : {}),
        },
      ],
      by,
      ctx.now,
    );
    return { list, value: String(value).trim(), added: added > 0 };
  } catch (cause) {
    if (cause instanceof AppError) throw new StepFailure(cause.message);
    throw cause;
  }
}
