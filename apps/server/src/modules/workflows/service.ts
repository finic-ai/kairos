import { featureValues, lastDue, parseCron, type Decider, type Decision, type FeatureValues } from "@kairos/core";
import type { WorkflowRunRow } from "../../db/schema";
import { createRepositories, type Repositories } from "../../repositories";
import { hashToken, newId, newToken } from "../../platform/crypto";
import type { Executor } from "../../platform/database";
import { AppError, invalid, notFound } from "../../platform/error";
import type { ModuleJobs } from "../../platform/jobs/worker";
import { ActionsService } from "../../services/action.service";
import { saveVersion } from "../../services/definition_version.service";
import { LabelsService } from "../../services/label.service";
import { WorkflowRunsService, WorkflowsService, type WorkflowView } from "../../services/workflow.service";
import { canStartAutomatic } from "../decisions/libs";
import type { Assessment, DecideRequest, DecisionFlowOptions } from "../decisions/service";
import type { EventVia, StoredEvent } from "../ingest/types";
import { describeModel, type StepScore } from "../models";
import {
  createWorkflowRunner,
  csvLine,
  enqueueRunJob,
  executeRun,
  evaluateCondition,
  modelProblems,
  outcomeOf,
  parseDuration,
  parseExpression,
  readFeatures,
  runVariables,
  stepOutputs,
  validateWorkflow,
  wakeNext,
  type StepEntry,
  type WorkflowRunnerDeps,
} from "./libs";
import type { TrainingDataBody } from "./schema";
import { scheduledWorkflows, workflowByHook } from "./repo";
import {
  DECISION_OUTCOMES,
  DECISION_WAIT_SECONDS,
  MAX_OPEN_RUNS,
  WORKFLOW_RUN_KIND,
  type WorkflowDefinitionDef,
} from "./types";

type Scope = { workspaceId: string; environmentId: string };

export interface WorkflowRunView {
  id: string;
  /** Null only for a test run of a workflow that was never saved. */
  workflow_id: string | null;
  workflow: string;
  status: WorkflowRunRow["status"];
  trigger: Record<string, unknown>;
  steps: unknown[];
  /** What the run gave, once it is done: a Return step's value, else the output of the last step. */
  output: unknown;
  error: string | null;
  test: boolean;
  /** The unsaved definition a test run ran. A run of a saved version reads it from the version. */
  definition?: Record<string, unknown>;
  created: string;
  started: string | null;
  finished: string | null;
}

export const toRunView = (r: WorkflowRunRow): WorkflowRunView => {
  const { live_steps: _live, mock_outputs: _mocks, ...trigger } = r.trigger as Record<string, unknown>;
  return {
    id: r.id,
    workflow_id: r.workflowId,
    workflow: r.workflow,
    status: r.status,
    trigger,
    steps: (r.steps ?? []) as unknown[],
    output: r.output ?? null,
    error: r.error,
    test: r.test,
    ...(r.definition ? { definition: r.definition as Record<string, unknown> } : {}),
    created: r.created.toISOString(),
    started: r.started?.toISOString() ?? null,
    finished: r.finished?.toISOString() ?? null,
  };
};

export async function checkModels(db: Executor, scope: Scope, steps: unknown): Promise<void> {
  const problems = await modelProblems(steps, (ref) => describeModel(db, scope, ref));
  if (problems.length) throw invalid(problems.join("; "));
}

/** Save a workflow definition as its next version. The display name and the switch are columns, not a version. */
export async function saveWorkflow(
  db: Executor,
  scope: Scope,
  definition: WorkflowDefinitionDef,
  by: string | null,
  now: Date,
): Promise<WorkflowView> {
  const problems = validateWorkflow(definition);
  if (problems.length) throw invalid(problems.join("; "));
  await checkModels(db, scope, definition.steps);
  const { name, displayName, enabled, trigger, steps } = definition;
  return db.transaction(async (tx) => {
    const current = await live(tx, scope, name);
    await onlyDecisionWorkflow(tx, scope, name, trigger);
    const saved = await saveVersion(tx, scope, "workflow", name, { trigger, steps }, by, now);
    const workflows = new WorkflowsService(tx, scope);
    const columns = {
      version: saved.version,
      definition: { trigger, steps },
      triggerType: trigger.type,
      displayName: displayName ?? current?.displayName ?? null,
      enabled: enabled ?? current?.enabled ?? true,
      status: "published" as const,
      publishedAt: now,
      ...(current?.draft && sameDefinition(current.draft, { trigger, steps }) ? { draft: null } : {}),
    };
    if (!current) await workflows.create({ name, ...columns }, now);
    else await workflows.updateMany({ name }, columns, now);
    return (await workflows.findByName(name))!;
  });
}

/** An action has one published decision workflow: another one cannot be published for it. */
async function onlyDecisionWorkflow(db: Executor, scope: Scope, name: string, trigger: Record<string, unknown>) {
  if (trigger.type !== "decision") return;
  const other = await new WorkflowsService(db, scope).decisionWorkflowOf(String(trigger.action), name);
  if (other)
    throw invalid(
      `trigger.action: the workflow "${other.displayName ?? other.name}" makes the decisions of "${String(trigger.action)}": archive it, or change its trigger, first`,
    );
}

/** A draft is at most this big, as JSON: about ten times a workflow of 50 steps. */
const MAX_DRAFT_BYTES = 512 * 1024;

type DraftBody = Pick<WorkflowDefinitionDef, "name" | "displayName" | "trigger" | "steps">;

const sameDefinition = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function live(db: Executor, scope: Scope, name: string) {
  const row = await new WorkflowsService(db, scope).findFirst({ where: { name } });
  if (row?.status === "archived") throw invalid(`the workflow "${name}" is archived: restore it first`);
  return row;
}

/**
 * Save changes as the draft. Runs do not read a draft, so it can still have problems; a publish
 * checks it. A new workflow starts as a draft, at version 0. A draft equal to the live version
 * is no draft. The display name is not part of a version, so it changes at once.
 */
export async function saveDraft(db: Executor, scope: Scope, body: DraftBody, now: Date): Promise<WorkflowView> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(body.name ?? ""))
    throw invalid('name: must be a name such as "review_withdrawals"');
  if (!body.trigger || typeof body.trigger !== "object" || typeof body.trigger.type !== "string")
    throw invalid("trigger: a workflow has one trigger");
  if (!Array.isArray(body.steps)) throw invalid("steps: must be a list of steps");
  const draft = { trigger: body.trigger, steps: body.steps };
  if (Buffer.byteLength(JSON.stringify(draft)) > MAX_DRAFT_BYTES) throw invalid("the workflow is too big to save");
  return db.transaction(async (tx) => {
    const workflows = new WorkflowsService(tx, scope);
    const current = await live(tx, scope, body.name);
    const displayName = body.displayName?.trim() || null;
    if (!current)
      await workflows.create(
        {
          name: body.name,
          version: 0,
          definition: draft,
          triggerType: body.trigger.type,
          displayName,
          enabled: true,
          status: "draft",
          draft,
        },
        now,
      );
    else
      await workflows.updateMany(
        { name: body.name },
        {
          displayName,
          // An unpublished workflow keeps its draft, even when it equals the empty start.
          draft: current.version > 0 && sameDefinition(draft, current.definition) ? null : draft,
          ...(current.version === 0 ? { definition: draft, triggerType: body.trigger.type } : {}),
        },
        now,
      );
    return (await workflows.findByName(body.name))!;
  });
}

/** Make the draft the next live version. It is checked as any save is. */
export async function publishWorkflow(
  db: Executor,
  scope: Scope,
  name: string,
  by: string | null,
  now: Date,
): Promise<WorkflowView | null> {
  const current = await live(db, scope, name);
  if (!current) return null;
  if (!current.draft && current.version > 0) throw invalid("there are no changes to publish");
  const draft = (current.draft ?? current.definition) as Pick<WorkflowDefinitionDef, "trigger" | "steps">;
  return db.transaction(async (tx) => {
    await saveWorkflow(
      tx,
      scope,
      { name, trigger: draft.trigger, steps: draft.steps } as WorkflowDefinitionDef,
      by,
      now,
    );
    const workflows = new WorkflowsService(tx, scope);
    await workflows.updateMany({ name }, { draft: null }, now);
    return workflows.findByName(name);
  });
}

/** Drop the draft: the builder goes back to the live version. A workflow that was never published has nothing to go back to. */
export async function discardDraft(db: Executor, scope: Scope, name: string, now: Date): Promise<WorkflowView | null> {
  const current = await live(db, scope, name);
  if (!current) return null;
  if (current.version === 0) throw invalid("the workflow was never published: archive it instead");
  const workflows = new WorkflowsService(db, scope);
  await workflows.updateMany({ name }, { draft: null }, now);
  return workflows.findByName(name);
}

/** Pause or activate a workflow, or rename it. Neither is a version. */
export async function updateWorkflow(
  db: Executor,
  scope: Scope,
  name: string,
  change: { enabled?: unknown; displayName?: unknown },
  now: Date,
): Promise<WorkflowView | null> {
  if (change.enabled !== undefined && typeof change.enabled !== "boolean") throw invalid("enabled: true or false");
  if (change.displayName !== undefined && change.displayName !== null && typeof change.displayName !== "string")
    throw invalid("displayName: a text");
  const current = await live(db, scope, name);
  if (!current) return null;
  const workflows = new WorkflowsService(db, scope);
  await workflows.updateMany(
    { name },
    {
      ...(change.enabled !== undefined ? { enabled: change.enabled as boolean } : {}),
      ...(change.displayName !== undefined
        ? { displayName: (change.displayName as string | null)?.trim() || null }
        : {}),
    },
    now,
  );
  return workflows.findByName(name);
}

/** Archive a workflow, or restore it. Runs that are open finish; an archived workflow starts no new ones. */
export async function setArchived(
  db: Executor,
  scope: Scope,
  name: string,
  archived: boolean,
  now: Date,
): Promise<WorkflowView | null> {
  const workflows = new WorkflowsService(db, scope);
  const current = await workflows.findFirst({ where: { name } });
  if (!current) return null;
  if (!archived && current.version > 0)
    await onlyDecisionWorkflow(db, scope, name, (current.definition as { trigger: Record<string, unknown> }).trigger);
  await workflows.updateMany(
    { name },
    { status: archived ? "archived" : current.version > 0 ? "published" : "draft" },
    now,
  );
  return workflows.findByName(name);
}

export interface StartRunArgs {
  /** Null only for a test run of a workflow that was never saved. */
  workflowId: string | null;
  /** The workflow's key, for the run's label "name@version". */
  name: string;
  /** The version the run starts with. 0 with a `definition`: a test run of an unsaved definition. */
  version: number;
  key: string;
  trigger: Record<string, unknown>;
  test?: boolean;
  definition?: Record<string, unknown>;
  parentRunId?: string;
  depth?: number;
  /** Takes no place among the workflow's open runs, as a test run: a caller waits for it. */
  immediate?: boolean;
  /** When the first job runs. Later than now for a run that the request runs itself. */
  firstJobAt?: Date;
  /** Write no job: the caller runs the run itself, and writes its next job if it needs one. */
  noJob?: boolean;
}

/**
 * Write a run and its first job in one transaction. A second run with the same key is the
 * same run: the existing one comes back. When 20 runs of the workflow are open, the run
 * waits with no job, and starts when one finishes.
 */
export async function startRun(
  repos: Repositories,
  scope: Scope,
  args: StartRunArgs,
  now: Date,
): Promise<WorkflowRunRow> {
  return (await writeRun(repos, scope, args, now)).run;
}

async function writeRun(
  repos: Repositories,
  scope: Scope,
  args: StartRunArgs,
  now: Date,
): Promise<{ run: WorkflowRunRow; inserted: boolean }> {
  return repos.transaction(async (tx) => {
    const runs = new WorkflowRunsService(tx.db, scope);
    const inserted = await runs.createIfMissing(
      {
        workflowId: args.workflowId,
        workflow: `${args.name}@${args.version === 0 ? "draft" : args.version}`,
        key: args.key,
        status: "queued",
        trigger: args.trigger,
        definition: args.definition ?? null,
        steps: [],
        segment: 0,
        test: args.test ?? false,
        parentRunId: args.parentRunId ?? null,
        depth: args.depth ?? 0,
      },
      now,
      ["workflowId", "key"],
    );
    const run = await runs.findFirst({
      where: { workflowId: args.workflowId ?? { isNull: true }, key: args.key },
    });
    if (!run) throw new Error("the run was written but cannot be read");
    // A test run, or one that a caller waits for, does not wait for a place: a person waits for it.
    const atOnce = args.test || args.immediate || !args.workflowId;
    if (inserted && !args.noJob && (atOnce || (await runs.countOpen(args.workflowId!)) < MAX_OPEN_RUNS))
      await enqueueRunJob(tx, { id: run.id, segment: 0 }, scope, args.firstJobAt ?? now, now);
    return { run, inserted };
  });
}

/** The time a run that is waited for can take past its budget: the step that runs at the end, and a margin. */
const WAIT_GRACE_MS = 75_000;

/**
 * Start a run and run it in this request, for at most `waitSeconds`, or to its Answer step. Its
 * first job waits past that time, so a run whose process stops goes on; the job goes when the run
 * stops here. A run that stops before its end writes its next job, as any run does.
 */
export async function runAndWait(
  deps: WorkflowRunnerDeps,
  scope: Scope,
  args: StartRunArgs,
  waitSeconds: number,
  now: Date,
): Promise<{ run: WorkflowRunRow; answered: boolean }> {
  const budgetMs = waitSeconds * 1000;
  const { run, inserted } = await writeRun(
    deps.repos,
    scope,
    { ...args, immediate: true, firstJobAt: new Date(now.getTime() + budgetMs + WAIT_GRACE_MS) },
    now,
  );
  let answered = false;
  if (inserted) {
    ({ answered } = await executeRun(deps, scope, run.id, 1, { budgetMs, stopAtAnswer: true }));
    await deps.repos.jobs.deletePending(WORKFLOW_RUN_KIND, `${run.id}:1`);
  }
  return { run: (await new WorkflowRunsService(deps.repos.db, scope).findById(run.id))!, answered };
}

/** A decision a decision workflow made, and what to do with its run once the decision is saved, or not. */
export interface WorkflowDecision extends Assessment {
  runId: string;
  /** The workflow and its version, as "name@version". */
  workflow: string;
  scores: StepScore[];
  /**
   * In the decision's transaction: the run learns the decision's id, and its steps after the
   * answer go on, unless the decision is as of a past moment.
   */
  saved(tx: Pick<Repositories, "db" | "jobs">, decisionId: string, now: Date, live: boolean): Promise<void>;
  /** The decision was not saved, as another one was made for its event first: the run stops. */
  dropped(now: Date): Promise<void>;
}

const workflowFailed = (message: string) => new AppError("bad_gateway", "workflow_failed", message);

/**
 * Make a decision with the action's decision workflow: run it in this request, to its answer.
 * A run that fails, or does not answer in its time, fails the decision. The answer's fields
 * that the workflow does not give come from its last "Ask the model" step.
 */
export async function decideByWorkflow(
  db: Executor,
  decider: Decider,
  scope: Scope,
  workflow: WorkflowView,
  request: DecideRequest,
  asOf: Date,
  flow: DecisionFlowOptions,
): Promise<WorkflowDecision> {
  const repos = createRepositories(db);
  const runs = new WorkflowRunsService(db, scope);
  const now = new Date();
  // A Decide step of another workflow can start this one: the chain rules apply.
  const parentRunId = typeof request.metadata?.workflow_run_id === "string" ? request.metadata.workflow_run_id : null;
  const depth = parentRunId ? ((await runs.findById(parentRunId))?.depth ?? 0) + 1 : 0;
  if (depth > 3) throw workflowFailed("a chain of workflows stops at depth 3");
  const trigger = {
    action: request.action.name,
    entities: request.entities,
    properties: request.properties ?? {},
    ...(request.session ? { session: request.session } : {}),
    ...(request.eventId ? { event_id: request.eventId } : {}),
    ...(request.automatic ? { automatic: true } : {}),
    ts: asOf.toISOString(),
  };
  const { run } = await writeRun(
    repos,
    scope,
    {
      workflowId: workflow.id,
      name: workflow.name,
      version: workflow.version,
      key: `decision:${newId("run")}`,
      trigger,
      immediate: true,
      noJob: true,
      ...(parentRunId ? { parentRunId } : {}),
      depth,
    },
    now,
  );
  const seen: { assessment?: Assessment; scores: StepScore[] } = { scores: [] };
  const seconds = Number(workflow.trigger.timeout_seconds ?? DECISION_WAIT_SECONDS);
  await executeRun(
    {
      repos,
      decider,
      now: () => new Date(),
      allowPrivate: flow.allowPrivate,
      ...(flow.wake ? { wake: flow.wake } : {}),
      onAssess: (_runId, assessment) => (seen.assessment = assessment as Assessment),
      onScore: (_runId, score) => seen.scores.push(score),
    },
    scope,
    run.id,
    0,
    { budgetMs: seconds * 1000, decision: true },
  );
  const after = (await runs.findById(run.id))!;
  const fails = (why: string) => workflowFailed(`The decision workflow "${workflow.name}" ${why} (run ${run.id})`);
  if (after.status === "failed") throw fails(`failed: ${after.error}`);
  if (after.status === "filtered") throw fails("ended at a filter, with no answer");
  if (after.status === "cancelled") throw fails("was cancelled");
  const answer = (after.output ?? {}) as Record<string, unknown>;
  if (typeof answer.outcome !== "string" || !(DECISION_OUTCOMES as readonly string[]).includes(answer.outcome))
    throw fails(`answered ${JSON.stringify(answer.outcome ?? null)}, not one of ${DECISION_OUTCOMES.join(", ")}`);

  const label = `${workflow.name}@${workflow.version}`;
  const goesOn = after.status === "waiting";
  // Without the model, the decision keeps which workflow made it, in place of what the model saw and said.
  const made = { workflow: label, run_id: run.id };
  return {
    decision: decisionOf(answer, seen.assessment?.decision, request),
    context: seen.assessment?.context ?? made,
    raw: seen.assessment?.raw ?? made,
    runId: run.id,
    workflow: label,
    scores: seen.scores,
    async saved(tx, decisionId, at, live) {
      const inTx = new WorkflowRunsService(tx.db, scope);
      await inTx.updateMany({ id: run.id }, { trigger: { ...trigger, decision_id: decisionId } }, at);
      if (!goesOn) return;
      if (live) await enqueueRunJob(tx, { id: run.id, segment: after.segment }, scope, at, at);
      else
        await inTx.updateMany(
          { id: run.id },
          {
            status: "cancelled",
            error: "a decision as of a past moment does not go on after its answer",
            finished: at,
          },
          at,
        );
    },
    async dropped(at) {
      if (goesOn)
        await runs.updateMany(
          { id: run.id, status: "waiting" },
          { status: "cancelled", error: "another decision was made for this event first", finished: at },
          at,
        );
    },
  };
}

/** What the answer does not give comes from the model, when it was asked. */
function decisionOf(answer: Record<string, unknown>, model: Decision | undefined, request: DecideRequest): Decision {
  const probability =
    typeof answer.probability === "number" && Number.isFinite(answer.probability)
      ? Math.max(0, Math.min(1, answer.probability))
      : null;
  const given =
    typeof answer.risk_score === "number" ? Math.max(0, Math.min(100, Math.round(answer.risk_score))) : null;
  const typology = typeof answer.typology === "string" ? answer.typology : model?.typology;
  return {
    decision: answer.outcome as Decision["decision"],
    probability: probability ?? (given !== null ? given / 100 : (model?.probability ?? 0)),
    risk_score: given ?? (probability !== null ? Math.round(probability * 100) : (model?.risk_score ?? 0)),
    reasons: Array.isArray(answer.reasons) ? answer.reasons.map(String) : (model?.reasons ?? []),
    ...(typology ? { typology } : {}),
    rules: Array.isArray(answer.rules) ? answer.rules.map(String) : [],
    action: model?.action ?? `${request.action.name}@${request.action.version}`,
  };
}

/** Cancel an open run: it stops, and its pending job is deleted. A finished run does not change. */
export async function cancelRun(
  repos: Repositories,
  scope: Scope,
  id: string,
  now: Date,
): Promise<WorkflowRunRow | null> {
  const runs = new WorkflowRunsService(repos.db, scope);
  const run = await runs.findById(id);
  if (!run) return null;
  if (!["queued", "running", "waiting"].includes(run.status)) return run;
  await runs.updateMany({ id }, { status: "cancelled", finished: now }, now);
  // A job that runs now stops at its next checkpoint; the job that waits goes.
  await repos.jobs.cancelPending(WORKFLOW_RUN_KIND, `${id}:`);
  if (run.workflowId) await wakeNext(repos, scope, run.workflowId, now);
  return runs.findById(id);
}

type RunStore = Pick<Repositories, "db" | "jobs" | "transaction">;

/** An event or a record change older than this is history: it starts no run, unless the trigger asks for a backfill. */
const HISTORY_MS = 3_600_000;

/**
 * Start one run that a trigger calls for. A workflow does not start itself: a change that one of
 * its own runs made starts none. A chain of workflows stops at depth 3, with a failed run that
 * says so.
 */
async function startTriggered(
  tx: RunStore,
  scope: Scope,
  workflow: WorkflowView,
  key: string,
  trigger: Record<string, unknown>,
  madeBy: string | undefined,
  now: Date,
): Promise<boolean> {
  let depth = 0;
  let parentRunId: string | undefined;
  if (madeBy) {
    const parent = await new WorkflowRunsService(tx.db, scope).findById(madeBy);
    if (parent?.workflowId === workflow.id) return false;
    depth = (parent?.depth ?? 0) + 1;
    parentRunId = madeBy;
  }
  if (depth > 3) {
    await new WorkflowRunsService(tx.db, scope).createIfMissing(
      {
        workflowId: workflow.id,
        workflow: `${workflow.name}@${workflow.version}`,
        key,
        status: "failed",
        trigger,
        definition: null,
        steps: [],
        segment: 0,
        test: false,
        parentRunId: parentRunId ?? null,
        depth,
        error: "a chain of workflows stops at depth 3",
      },
      now,
      ["workflowId", "key"],
    );
    return true;
  }
  await startRun(
    tx as Repositories,
    scope,
    {
      workflowId: workflow.id,
      name: workflow.name,
      version: workflow.version,
      key,
      trigger,
      ...(parentRunId ? { parentRunId } : {}),
      depth,
    },
    now,
  );
  return true;
}

/** Whether a trigger's `when` passes. A condition that cannot be read starts nothing. */
const passes = (when: unknown, variables: Record<string, unknown>) => {
  if (typeof when !== "string" || !when) return true;
  try {
    return evaluateCondition(when, variables);
  } catch {
    return false;
  }
};

/**
 * Start the runs that events which were just stored call for: the app event triggers of their
 * type, and the record triggers on any stored event. Call it in the transaction that stores
 * them, as for automatic decisions. Returns how many runs were written.
 */
export async function startEventRuns(
  tx: RunStore,
  scope: Scope,
  stored: StoredEvent[],
  via: EventVia | undefined,
  now: Date,
): Promise<number> {
  if (stored.length === 0) return 0;
  const workflows = new WorkflowsService(tx.db, scope);
  const types = [...new Set(stored.map((e) => e.type))];
  const byType = (await Promise.all(types.map((t) => workflows.eventTriggered(t)))).flat();
  const onAny = await workflows.recordTriggered("event", "created");
  if (byType.length === 0 && onAny.length === 0) return 0;
  let started = 0;
  for (const event of stored) {
    const input = {
      id: event.id,
      type: event.type,
      ts: event.ts,
      entities: event.entities,
      properties: event.properties,
      ...(event.status ? { status: event.status } : {}),
      ...(event.session ? { session: event.session } : {}),
    };
    const madeBy = typeof event.metadata?.workflow_run_id === "string" ? event.metadata.workflow_run_id : undefined;
    for (const workflow of [...byType.filter((w) => w.trigger.event === event.type), ...onAny]) {
      const trigger = workflow.trigger as {
        type: string;
        status?: string | string[];
        when?: string;
        allowPublic?: boolean;
        backfill?: boolean;
      };
      if (via === "public" && !trigger.allowPublic) continue;
      if (via !== "workflow" && via !== undefined && !canStartAutomatic(via) && via !== "public") continue;
      if (trigger.status && ![trigger.status].flat().includes(event.status ?? "")) continue;
      if (!trigger.backfill && Date.parse(event.ts) < now.getTime() - HISTORY_MS) continue;
      const runInput = trigger.type === "record" ? { record: "event", on: "created", event: input } : { event: input };
      if (!passes(trigger.when, { event: input, trigger: trigger.type === "record" ? runInput : input })) continue;
      if (await startTriggered(tx, scope, workflow, `event:${event.id}`, runInput, madeBy, now)) started++;
    }
  }
  return started;
}

/** A change to a record in Kairos, for the workflows whose record trigger asks for it. */
export interface RecordChange {
  record: "entity" | "decision";
  on: "created" | "updated" | "labelled";
  /** One key for one change, so that it starts one run: "user/u1@<time>", a decision id. */
  key: string;
  /** What the run reads as `trigger`, besides `record` and `on`: `{ entity }`, `{ decision }`. */
  input: Record<string, unknown>;
  /** The entity type of an entity, or the action of a decision: a trigger can ask for one. */
  kind: string;
  /** For a new label: the label, which a trigger can ask for. */
  label?: string;
  /** A change from the history starts no run, unless the trigger asks for a backfill. */
  ts: string;
  /** The workflow run that made the change, for the chain rules. */
  madeBy?: string;
}

/**
 * Start the runs that a change to an entity or a decision calls for. Call it in the transaction
 * that writes the change, so that a stopped process loses no run. Returns how many it wrote.
 */
export async function startRecordRuns(db: Executor, scope: Scope, change: RecordChange, now: Date): Promise<number> {
  const tx = createRepositories(db);
  const candidates = await new WorkflowsService(db, scope).recordTriggered(change.record, change.on);
  let started = 0;
  for (const workflow of candidates) {
    const trigger = workflow.trigger as {
      entity?: string;
      action?: string;
      label?: string;
      when?: string;
      backfill?: boolean;
    };
    const wanted = change.record === "entity" ? trigger.entity : trigger.action;
    if (wanted && wanted !== change.kind) continue;
    if (change.on === "labelled" && trigger.label && trigger.label !== change.label) continue;
    if (!trigger.backfill && Date.parse(change.ts) < now.getTime() - HISTORY_MS) continue;
    const input = { record: change.record, on: change.on, ...change.input };
    if (!passes(trigger.when, { trigger: input, ...change.input })) continue;
    const key = `${change.record}.${change.on}:${change.key}`;
    if (await startTriggered(tx, scope, workflow, key, input, change.madeBy, now)) started++;
  }
  return started;
}

/** The run id that a manual start uses when the caller sends no idempotency key. */
export const newRunKey = () => `manual:${newId("run")}`;

const SCHEDULE_KIND = "workflow.schedule";

/**
 * Start the scheduled runs that are due: for each published, active workflow with a schedule,
 * the latest due minute since it was published, at most a day back. A server that was down
 * runs only the latest time it missed. The key is the minute, so the minute runs once.
 * Returns how many workflows were due, whether or not their run was there already.
 */
export async function startScheduledRuns(repos: Repositories, now: Date): Promise<number> {
  let started = 0;
  for (const w of await scheduledWorkflows(repos.db)) {
    let cron;
    try {
      cron = parseCron(String(w.trigger.cron ?? ""));
    } catch {
      continue;
    }
    const zone = w.trigger.timezone || "UTC";
    const after = w.published_at ? new Date(w.published_at) : new Date(now.getTime() - 86_400_000);
    const due = lastDue(cron, after, now, zone);
    if (!due) continue;
    await startRun(
      repos,
      { workspaceId: w.workspace_id, environmentId: w.environment_id },
      {
        workflowId: w.id,
        name: w.name,
        version: w.version,
        key: `schedule:${due.toISOString()}`,
        trigger: { scheduled_at: due.toISOString(), timezone: zone },
      },
      now,
    );
    started++;
  }
  return started;
}

/** The workflows' background work: the runs, and each minute the check of the schedules. */
export function workflowJobs(deps: WorkflowRunnerDeps): ModuleJobs {
  return {
    kinds: [
      createWorkflowRunner(deps),
      {
        kind: SCHEDULE_KIND,
        concurrency: 1,
        retryDelaysMs: [],
        timeoutMs: 30_000,
        async run() {
          await startScheduledRuns(deps.repos, deps.now());
        },
      },
    ],
    schedules: [{ kind: SCHEDULE_KIND, everyMs: 60_000 }],
  };
}

/** Make the URL of a workflow's webhook trigger. The token is kept hashed: the URL is shown now, and not again. */
export async function newHookToken(
  db: Executor,
  scope: Scope,
  name: string,
  now: Date,
): Promise<{ token: string; hint: string } | null> {
  if (!(await live(db, scope, name))) return null;
  const workflows = new WorkflowsService(db, scope);
  const token = `wfh_${newToken(24)}`;
  const hint = token.slice(-4);
  await workflows.updateMany({ name }, { hookTokenHash: hashToken(token), hookTokenHint: hint }, now);
  return { token, hint };
}

/** The headers a run keeps from a delivery: not the ones that hold credentials. */
const DROPPED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

export interface HookDelivery {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** The body as text; JSON is read from it. At most 1 MB, checked by the route. */
  body: string;
}

/**
 * Start a run of the workflow whose webhook URL has this token. The provider does not wait for
 * the steps: the answer is the run's id. A header that the trigger names gives the delivery's
 * id, so a delivery sent twice is one run.
 */
export async function receiveHook(
  repos: Repositories,
  token: string,
  delivery: HookDelivery,
  now: Date,
): Promise<{ status: 202 | 404 | 405 | 409; body: Record<string, unknown> }> {
  const found = await workflowByHook(repos.db, hashToken(token));
  const missing = { status: 404 as const, body: { error: { type: "not_found", message: "No such workflow hook" } } };
  if (!found) return missing;
  const scope = { workspaceId: found.workspace_id, environmentId: found.environment_id };
  const workflow = await new WorkflowsService(repos.db, scope).findByName(found.name);
  if (!workflow || workflow.trigger.type !== "webhook") return missing;
  if (workflow.status !== "published" || !workflow.enabled)
    return {
      status: 409,
      body: { error: { type: "unavailable", message: "The workflow is not published and active" } },
    };
  const method = String(workflow.trigger.method ?? "POST");
  if (delivery.method !== method)
    return { status: 405, body: { error: { type: "method_not_allowed", message: `Send a ${method}` } } };
  const headers = Object.fromEntries(
    Object.entries(delivery.headers)
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .filter(([k]) => !DROPPED_HEADERS.has(k)),
  );
  let body: unknown = delivery.body;
  try {
    body = delivery.body ? JSON.parse(delivery.body) : null;
  } catch {
    /* the body is text */
  }
  const idHeader =
    typeof workflow.trigger.idempotency_header === "string" ? workflow.trigger.idempotency_header.toLowerCase() : "";
  const deliveryId = idHeader ? headers[idHeader] : undefined;
  const run = await startRun(
    repos,
    scope,
    {
      workflowId: workflow.id,
      name: workflow.name,
      version: workflow.version,
      key: deliveryId ? `webhook:${deliveryId}` : `webhook:${newId("dlv")}`,
      trigger: { method, headers, query: delivery.query, body, received_at: now.toISOString() },
    },
    now,
  );
  return { status: 202, body: { run_id: run.id } };
}

const MAX_WINDOW_MS = 3650 * 86_400_000;
const PAGE = 1000;

export interface TrainingCounts {
  rows: number;
  positives: number;
  already_labeled: number;
  outcome_unknown: number;
  no_subject: number;
}

export interface TrainingData {
  csv: string;
  counts: TrainingCounts;
}

export interface TrainingRow {
  run: string;
  at: Date;
  subject: string;
  label: 0 | 1;
  /** One for each feature, in the order of the names. NaN is a missing value. */
  values: Float64Array;
}

export interface TrainingRows {
  names: string[];
  subjectType: string;
  rows: TrainingRow[];
  counts: TrainingCounts;
}

export async function collectTrainingRows(
  db: Executor,
  scope: Scope,
  name: string,
  body: TrainingDataBody & { newest?: boolean },
  now: Date,
): Promise<TrainingRows> {
  const workflow = await new WorkflowsService(db, scope).findByName(name);
  if (!workflow) throw notFound(`No workflow "${name}"`);
  const windowMs = parseDuration(body.window)!;
  if (windowMs > MAX_WINDOW_MS) throw invalid("window: at most 3650d");
  for (const [feature, value] of Object.entries(body.features)) {
    if (typeof value !== "string" || !/^\s*\{\{[\s\S]+\}\}\s*$/.test(value)) continue;
    const problem = parseExpression(value.trim().slice(2, -2));
    if (problem) throw invalid(`features.${feature}: ${problem}`);
  }
  let subject = body.subject;
  if (!subject && workflow.trigger.type === "decision") {
    const action = await new ActionsService(db, scope).findLatest(String(workflow.trigger.action));
    if (action) subject = { type: action.subject, id: `{{ trigger.entities.${action.subject} }}` };
  }
  if (!subject) throw invalid('subject: the entity each run is about, as { "type": "user", "id": "{{ … }}" }');

  const names = Object.keys(body.features);
  const limit = body.limit ?? 200_000;
  const from = body.from ? new Date(body.from) : null;
  const to = body.to ? new Date(body.to) : null;
  const counts = { rows: 0, positives: 0, already_labeled: 0, outcome_unknown: 0, no_subject: 0 };
  const out: TrainingRow[] = [];
  const runs = new WorkflowRunsService(db, scope);
  const labels = new LabelsService(db, scope);

  for (let cursor = ""; counts.rows < limit;) {
    const page = await runs.listFinished(workflow.id, cursor, PAGE, body.newest);
    if (page.length === 0) break;
    cursor = page.at(-1)!.id;
    const rows: { run: string; at: Date; id: string; values: FeatureValues }[] = [];
    for (const run of page) {
      const trigger = run.trigger as Record<string, unknown>;
      // A decision as of a past moment has that moment as its time, not the time of the run.
      const at = typeof trigger.ts === "string" ? new Date(trigger.ts) : run.created;
      if ((from && at < from) || (to && at >= to)) continue;
      const version = Number(run.workflow.split("@").at(-1));
      const vars = {
        ...runVariables(run, name, version),
        steps: stepOutputs((run.steps ?? []) as unknown as StepEntry[]),
      };
      const id = readFeatures({ id: subject.id }, vars).id;
      if ((typeof id !== "string" && typeof id !== "number") || id === "") {
        counts.no_subject++;
        continue;
      }
      rows.push({ run: run.id, at, id: String(id), values: featureValues(names, readFeatures(body.features, vars)) });
    }
    const times = await labels.timesFor(subject.type, [...new Set(rows.map((r) => r.id))], body.labels);
    for (const row of rows) {
      const outcome = outcomeOf(row.at, times.get(row.id) ?? [], windowMs, now);
      if (outcome === "already_labeled" || outcome === "outcome_unknown") {
        counts[outcome]++;
        continue;
      }
      if (counts.rows >= limit) break;
      counts.rows++;
      counts.positives += outcome;
      out.push({
        run: row.run,
        at: row.at,
        subject: row.id,
        label: outcome,
        values: Float64Array.from(row.values.row),
      });
    }
  }
  return { names, subjectType: subject.type, rows: out, counts };
}

export async function exportTrainingData(
  db: Executor,
  scope: Scope,
  name: string,
  body: TrainingDataBody,
  now: Date,
): Promise<TrainingData> {
  const { names, subjectType, rows, counts } = await collectTrainingRows(db, scope, name, body, now);
  const lines = [csvLine(["run_id", "ts", "subject_type", "subject_id", "label", ...names])];
  for (const row of rows)
    lines.push(
      csvLine([
        row.run,
        row.at.toISOString(),
        subjectType,
        row.subject,
        row.label,
        ...Array.from(row.values, (v) => (Number.isNaN(v) ? null : v)),
      ]),
    );
  return { csv: `${lines.join("\n")}\n`, counts };
}
