import type { WorkflowRow } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso } from "../platform/sql";
import { DefinitionVersionsService } from "./definition_version.service";

/** A workflow's live row as the API shows it: the definition, its version, and its columns. */
export interface WorkflowView {
  id: string;
  name: string;
  displayName?: string;
  enabled: boolean;
  version: number;
  trigger: Record<string, unknown>;
  steps: Record<string, unknown>[];
  status: WorkflowRow["status"];
  published_at?: string;
  /** When its runs started to fail. Absent while they do not fail. */
  failing_since?: string;
  /** Saved changes that are not published. */
  draft?: { trigger: Record<string, unknown>; steps: Record<string, unknown>[] };
  /** For a webhook trigger with a URL: the last characters of its token. */
  hook?: { hint: string };
}

export const toWorkflowView = (r: WorkflowRow): WorkflowView => {
  const definition = r.definition as { trigger: Record<string, unknown>; steps: Record<string, unknown>[] };
  return {
    id: r.id,
    name: r.name,
    ...(r.displayName ? { displayName: r.displayName } : {}),
    enabled: r.enabled,
    version: r.version,
    trigger: definition.trigger,
    steps: definition.steps,
    status: r.status,
    ...(r.publishedAt ? { published_at: iso(r.publishedAt) } : {}),
    ...(r.failingSince ? { failing_since: iso(r.failingSince) } : {}),
    ...(r.draft ? { draft: r.draft as NonNullable<WorkflowView["draft"]> } : {}),
    ...(r.hookTokenHint ? { hook: { hint: r.hookTokenHint } } : {}),
  };
};

export class WorkflowsService extends DatabaseService<"workflows"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "workflows", scope);
  }

  async findByName(name: string): Promise<WorkflowView | null> {
    const r = await this.findFirst({ where: { name } });
    return r ? toWorkflowView(r) : null;
  }

  /** The workflows of the environment: the archived ones, or the others. */
  async listAll(archived = false): Promise<WorkflowView[]> {
    return (
      await this.findMany({
        where: { status: archived ? "archived" : { ne: "archived" } },
        orderBy: (t, { asc }) => [asc(t.name)],
      })
    ).map(toWorkflowView);
  }

  /** The published, active workflows that an event of this type can start. */
  async eventTriggered(eventType: string): Promise<WorkflowView[]> {
    const all = await this.findMany({
      where: { triggerType: "event", enabled: true, status: "published" },
    });
    return all.map(toWorkflowView).filter((w) => (w.trigger as { event?: string }).event === eventType);
  }

  /** The published, active workflows with a record trigger for this kind of record and change. */
  async recordTriggered(record: string, on: string): Promise<WorkflowView[]> {
    const all = await this.findMany({ where: { triggerType: "record", enabled: true, status: "published" } });
    return all
      .map(toWorkflowView)
      .filter((w) => (w.trigger as { record?: string }).record === record && (w.trigger as { on?: string }).on === on);
  }

  /**
   * The published workflow whose decision trigger names this action, paused or not: there is
   * at most one. `except` leaves one workflow out, for a check before it is published.
   */
  async decisionWorkflowOf(action: string, except?: string): Promise<WorkflowView | null> {
    const all = await this.findMany({ where: { triggerType: "decision", status: "published" } });
    return (
      all.map(toWorkflowView).find((w) => (w.trigger as { action?: string }).action === action && w.name !== except) ??
      null
    );
  }

  /** The workflow that makes this action's decisions now: published and active. */
  async decisionWorkflow(action: string): Promise<WorkflowView | null> {
    const found = await this.decisionWorkflowOf(action);
    return found?.enabled ? found : null;
  }

  /** One saved version of a workflow, current or old, from `definition_versions`. */
  async findVersion(name: string, version: number): Promise<WorkflowView | null> {
    const live = await this.findFirst({
      where: { name },
      columns: { id: true, displayName: true, enabled: true, status: true },
    });
    const r = await new DefinitionVersionsService(this.db, this.scope).get("workflow", name, version);
    if (!r) return null;
    const definition = r.definition as { trigger: Record<string, unknown>; steps: Record<string, unknown>[] };
    if (!live) return null;
    return {
      id: live.id,
      name,
      ...(live.displayName ? { displayName: live.displayName } : {}),
      enabled: live.enabled,
      status: live.status,
      version: r.version,
      trigger: definition.trigger,
      steps: definition.steps,
    };
  }

  async listVersions(name: string) {
    return new DefinitionVersionsService(this.db, this.scope).list("workflow", name);
  }
}

export class WorkflowRunsService extends DatabaseService<"workflowRuns"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "workflowRuns", scope);
  }

  /** Ids sort by time, so this is oldest first. */
  /** Oldest first after `cursor`, or newest first before it. */
  async listFinished(workflowId: string, cursor: string, limit: number, newest = false) {
    return this.findMany({
      where: {
        workflowId,
        test: false,
        status: { in: ["done", "waiting", "cancelled"] },
        ...(!newest ? { id: { gt: cursor } } : cursor ? { id: { lt: cursor } } : {}),
      },
      columns: { id: true, trigger: true, steps: true, created: true, workflow: true },
      orderBy: (t, { asc, desc }) => [newest ? desc(t.id) : asc(t.id)],
      limit,
    });
  }

  /**
   * Runs of one workflow that hold one of its places: running, waiting for a delay, or queued
   * with a job (a retry, or the next segment). A queued run with no job (segment 0) waits for a
   * place and holds none. Test runs hold none.
   */
  async countOpen(workflowId: string): Promise<number> {
    const rows = await this.findMany({
      where: {
        workflowId,
        test: false,
        OR: [{ status: { in: ["running", "waiting"] } }, { status: "queued", segment: { gt: 0 } }],
      },
      columns: { id: true },
    });
    return rows.length;
  }
}
