import type { Decider } from "@kairos/core";
import type { Repositories } from "../../../repositories";
import type { Executor } from "../../../platform/database";
import type { JobKind } from "../../../platform/jobs/worker";
import { WorkflowRunsService, WorkflowsService } from "../../../services/workflow.service";
import type { StepScore } from "../../models";
import { loadLists } from "../../rulesets";
import {
  evaluate,
  evaluateCondition,
  ExpressionError,
  listSlugsOf,
  parseDuration,
  resolveValue,
  TERMS,
  withLists,
  type Term,
  type Variables,
} from "./expressions";
import { runStep, StepFailure } from "./steps";
import { stepInput } from "./trace";
import { claimRun, takeNextQueued } from "../repo";
import { MAX_LOOP, MAX_OPEN_RUNS, MAX_RUN_DAYS, WORKFLOW_RUN_KIND, type WorkflowStepDef } from "../types";

/** One job runs steps for at most this long, then the run continues in its next job. */
const BUDGET_MS = 20_000;
const RETRY_BACKOFF_MS = [10_000, 60_000, 600_000, 3_600_000];
const MAX_RUN_MS = MAX_RUN_DAYS * 86_400_000;

export interface StepEntry {
  path: string;
  id: string;
  name: string;
  status: "done" | "failed" | "waiting";
  attempt: number;
  output?: unknown;
  /** The step's fields with their templates filled in. A field that reads a secret keeps its template. */
  input?: unknown;
  /** What a model step showed the model. */
  read?: unknown;
  /** The list items that `inList` matched in the step's expressions and templates. */
  terms?: Term[];
  error?: string | null;
  started?: string;
  finished?: string;
  /** A waiting delay: when it ends. */
  wake?: string;
}

type Stop =
  | { kind: "delay"; at: Date }
  | { kind: "retry"; at: Date }
  | { kind: "budget" }
  | { kind: "filtered" }
  | { kind: "returned"; value: unknown }
  | { kind: "answered" }
  | { kind: "failed"; error: string };

export interface WorkflowRunnerDeps {
  repos: Repositories;
  decider: Decider;
  now: () => Date;
  allowPrivate: boolean;
  wake?: () => void;
  /** Gets each "Ask the model" step's whole assessment, which the log does not keep. */
  onAssess?: (runId: string, assessment: unknown) => void;
  onScore?: (runId: string, score: StepScore) => void;
}

export interface RunMode {
  budgetMs: number;
  /** A caller waits: the run stops at its Answer step, and the rest goes on in a job. */
  stopAtAnswer?: boolean;
  /**
   * A decision: no step waits for a retry, and a run that stops before its answer fails. After
   * the answer, the run waits with no job: the caller writes it once the decision is saved.
   */
  decision?: boolean;
}

type EntryFields = Omit<StepEntry, "path" | "id" | "name" | "attempt"> & { attempt?: number };
const stamp = () => new Date().toISOString();
const MAX_TERMS = 20;

/** Each item once: the logged input fills the same templates again. */
export function termsOf(terms: readonly Term[]): { terms?: Term[] } {
  const seen = new Set<string>();
  const unique = terms.filter((t) => {
    const key = `${t.list}\u0000${t.item}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return unique.length ? { terms: unique.slice(0, MAX_TERMS) } : {};
}

/**
 * Enqueue the next job of a run, in the caller's transaction when there is one. The run's
 * `segment` counts its jobs, and this is the one place that moves it: each job's key is
 * "<run id>:<segment>", so no two jobs of a run share a key.
 */
export async function enqueueRunJob(
  repos: Pick<Repositories, "jobs" | "db">,
  run: { id: string; segment: number },
  scope: { workspaceId: string; environmentId: string },
  runAt: Date,
  now: Date,
): Promise<void> {
  await new WorkflowRunsService(repos.db, scope).updateMany({ id: run.id }, { segment: run.segment + 1 }, now);
  await repos.jobs.enqueue(
    {
      kind: WORKFLOW_RUN_KIND,
      key: `${run.id}:${run.segment + 1}`,
      payload: { run_id: run.id },
      runAt,
      workspaceId: scope.workspaceId,
      environmentId: scope.environmentId,
    },
    now,
  );
}

/** The run was cancelled while this job ran: it stops, and writes nothing more. */
class RunCancelled extends Error {}

export function stepOutputs(log: StepEntry[]): Record<string, { output: unknown }> {
  const out: Record<string, { output: unknown }> = {};
  for (const e of log) if (e.status === "done") out[e.id] = { output: e.output };
  return out;
}

export function runVariables(
  run: { id: string; created: Date; trigger: unknown },
  name: string,
  version: number,
): Variables {
  const {
    live_steps: _live,
    mock_outputs: _mocks,
    trigger_terms: _terms,
    ...triggerInput
  } = run.trigger as Record<string, unknown>;
  // An app event run reads the event as both `trigger` and `event`, as the trigger's `when` does.
  // A record trigger's run reads `{ record, on, … }` as `trigger`, and the record by its name too.
  const appEvent = triggerInput.event !== undefined && triggerInput.record === undefined;
  return {
    trigger: appEvent ? triggerInput.event : triggerInput,
    ...(typeof triggerInput.record === "string" && triggerInput[triggerInput.record] !== undefined
      ? { [triggerInput.record]: triggerInput[triggerInput.record] }
      : {}),
    ...(triggerInput.event !== undefined ? { event: triggerInput.event } : {}),
    run: { id: run.id, started: run.created.toISOString(), workflow: name, version },
  };
}

class Execution {
  stop: Stop | null = null;
  log: StepEntry[];
  /** An Answer step is done. */
  answered = false;
  private byPath = new Map<string, StepEntry>();

  constructor(
    private readonly deps: WorkflowRunnerDeps,
    private readonly runId: string,
    private readonly scope: { workspaceId: string; environmentId: string },
    entries: StepEntry[],
    readonly budgetEnd: number,
    readonly now: Date,
    /** A run lasts at most 30 days from when it was written. */
    readonly runStarted: Date,
    readonly mode: RunMode,
  ) {
    this.log = entries;
    for (const e of entries) this.byPath.set(e.path, e);
  }

  entry(path: string) {
    return this.byPath.get(path);
  }

  /** The outputs of finished steps, as expressions read them: `steps.<id>.output`. */
  outputs(): Record<string, { output: unknown }> {
    return stepOutputs(this.log);
  }

  /** Write a step's entry in the run's log. With `runOutput`, the run's output too, in the same write. */
  async record(
    step: WorkflowStepDef,
    path: string,
    fields: EntryFields,
    { db = this.deps.repos.db, runOutput }: { db?: Executor; runOutput?: { value: unknown } } = {},
  ) {
    const entry: StepEntry = { path, id: step.id, name: step.name, attempt: 1, ...fields };
    const at = this.byPath.get(path);
    if (at) Object.assign(at, entry);
    else (this.log.push(entry), this.byPath.set(path, entry));
    const written = await new WorkflowRunsService(db, this.scope).updateMany(
      { id: this.runId, status: { ne: "cancelled" } },
      {
        steps: this.log as unknown as Record<string, unknown>[],
        cursor: path,
        status: "running",
        ...(runOutput ? { output: runOutput.value } : {}),
      },
      this.now,
    );
    // In a record step's transaction, this also takes back the record's write.
    if (written.length === 0) throw new RunCancelled("the run was cancelled");
  }
}

export function createWorkflowRunner(deps: WorkflowRunnerDeps): JobKind<{ run_id: string }> {
  return {
    kind: WORKFLOW_RUN_KIND,
    concurrency: 4,
    retryDelaysMs: [30_000, 120_000],
    // The 20-second budget and one step of at most 15 seconds. Under the 45 seconds a cron drain has.
    timeoutMs: 40_000,
    leaseMs: 180_000,
    async run(payload, job) {
      const scope = { workspaceId: job.workspaceId!, environmentId: job.environmentId! };
      await executeRun(deps, scope, payload.run_id, Number(job.key?.split(":").at(-1)), { budgetMs: BUDGET_MS });
    },
  };
}

/** The type of each step, by its id, at any depth. */
function stepTypes(steps: WorkflowStepDef[], into = new Map<string, string>()) {
  for (const step of steps) {
    into.set(step.id, step.type);
    for (const branch of ["then", "else", "steps"])
      if (Array.isArray(step[branch])) stepTypes(step[branch] as WorkflowStepDef[], into);
  }
  return into;
}

/** A run's output without a Return step: the output of the last step that acted, or of the last loop. */
function lastOutput(log: StepEntry[], steps: WorkflowStepDef[]): unknown {
  const types = stepTypes(steps);
  for (const entry of [...log].reverse()) {
    const type = types.get(entry.id);
    if (entry.status === "done" && type && !["condition", "filter", "delay"].includes(type))
      return entry.output ?? null;
  }
  return null;
}

/**
 * Run the steps of one segment of a run: until it ends, waits, retries later, or uses its
 * budget. A job calls it, and so does a request that waits for the run, in a mode of its own.
 * When it stops before the end, the run's next job is written. Says whether the run answered.
 */
export async function executeRun(
  deps: WorkflowRunnerDeps,
  scope: { workspaceId: string; environmentId: string },
  runId: string,
  segment: number,
  mode: RunMode,
): Promise<{ answered: boolean }> {
  const notAnswered = { answered: false };
  const { workspaceId, environmentId } = scope;
  const now = deps.now();
  const runs = new WorkflowRunsService(deps.repos.db, scope);
  // Claim the run: a queued or waiting run, or this segment again after a crash.
  if (!(await claimRun(deps.repos.db, scope, runId, segment, now))) return notAnswered;
  const run = await runs.findById(runId);
  if (!run) return notAnswered;

  const open = { id: run.id, status: { ne: "cancelled" as const } };
  const fail = async (error: string) => {
    const written = await runs.updateMany(open, { status: "failed", error, finished: now }, now);
    if (run.workflowId) {
      if (written.length && !run.test) await markFailing(deps.repos, scope, run.workflowId, now);
      await wakeNext(deps.repos, scope, run.workflowId, now);
    }
  };

  const version = Number(run.workflow.split("@").at(-1));
  // The workflow is found by its id; a test run of a workflow never saved has only its label.
  const owner = run.workflowId
    ? await new WorkflowsService(deps.repos.db, scope).findFirst({ where: { id: run.workflowId } })
    : null;
  const name = owner?.name ?? run.workflow.slice(0, run.workflow.lastIndexOf("@"));
  const view = run.definition
    ? {
        name,
        version: 0,
        trigger: (run.definition as { trigger: Record<string, unknown> }).trigger,
        steps: (run.definition as { steps: Record<string, unknown>[] }).steps,
      }
    : await new WorkflowsService(deps.repos.db, scope).findVersion(name, version);
  if (!view) return (await fail(`the workflow "${name}" has no version ${version}`), notAnswered);
  const steps = view.steps as unknown as WorkflowStepDef[];

  const triggerInput = run.trigger as Record<string, unknown>;
  const liveSteps = new Set((triggerInput.live_steps as string[] | undefined) ?? []);
  const mockOutputs = (triggerInput.mock_outputs as Record<string, unknown> | undefined) ?? {};
  const listSlugs = listSlugsOf(steps);
  const baseVars = listSlugs.length
    ? withLists(runVariables(run, name, version), await loadLists(deps.repos.db, scope, listSlugs))
    : runVariables(run, name, version);
  const exec = new Execution(
    deps,
    run.id,
    scope,
    (run.steps as StepEntry[] | null) ?? [],
    Date.now() + mode.budgetMs,
    now,
    run.created,
    mode,
  );
  const types = stepTypes(steps);
  exec.answered = exec.log.some((e) => e.status === "done" && types.get(e.id) === "answer");
  const ctx = {
    repos: deps.repos,
    decider: deps.decider,
    workspaceId,
    environmentId,
    run: { id: run.id, test: run.test },
    liveSteps,
    mockOutputs,
    allowPrivate: deps.allowPrivate,
    now,
    ...(deps.wake ? { wake: deps.wake } : {}),
    ...(deps.onAssess ? { onAssess: (a: unknown) => deps.onAssess!(run.id, a) } : {}),
    ...(deps.onScore ? { onScore: (s: StepScore) => deps.onScore!(run.id, s) } : {}),
  };
  try {
    await execList(deps, exec, steps, "", baseVars, ctx);
  } catch (cause) {
    if (cause instanceof RunCancelled) return { answered: exec.answered };
    return (await fail((cause as Error).message), { answered: exec.answered });
  }

  const runsNow = deps.now();
  if (!exec.stop || exec.stop.kind === "filtered" || exec.stop.kind === "returned") {
    const status = exec.stop?.kind === "filtered" ? "filtered" : "done";
    // After an Answer, its value stays the output, whatever ends the run.
    const output =
      exec.stop?.kind === "returned" ? exec.stop.value : status === "done" ? lastOutput(exec.log, steps) : null;
    const written = await runs.updateMany(
      open,
      { status, ...(exec.answered ? {} : { output }), cursor: null, finished: runsNow },
      runsNow,
    );
    if (run.workflowId) {
      if (written.length && !run.test) await markFailing(deps.repos, scope, run.workflowId, null);
      await wakeNext(deps.repos, scope, run.workflowId, runsNow);
    }
  } else if (exec.stop.kind === "failed") {
    await fail(exec.stop.error);
  } else if (mode.decision && !exec.answered) {
    await fail(
      exec.stop.kind === "budget"
        ? `no answer within ${Math.round(mode.budgetMs / 1000)} s`
        : "the run would wait before its answer",
    );
  } else if (mode.decision && exec.stop.kind === "answered") {
    // The steps after the answer wait for the decision to be saved: the caller writes their job then.
    await runs.updateMany(open, { status: "waiting" }, runsNow);
  } else {
    const stop = exec.stop;
    const at = stop.kind === "budget" || stop.kind === "answered" ? runsNow : stop.at;
    // The status and the next job are one write: a crash between them would leave a run with no job.
    await deps.repos.transaction(async (tx) => {
      const paused = await new WorkflowRunsService(tx.db, scope).updateMany(
        open,
        { status: stop.kind === "delay" ? "waiting" : "queued" },
        runsNow,
      );
      if (paused.length) await enqueueRunJob(tx, { id: run.id, segment: run.segment }, scope, at, runsNow);
    });
  }
  return { answered: exec.answered };
}

/**
 * A run that fails marks its workflow as failing from now, unless it already is; a run that
 * finishes clears it. It is activity, so the workflow's `updated` does not change.
 */
async function markFailing(
  repos: Pick<Repositories, "db">,
  scope: { workspaceId: string; environmentId: string },
  workflowId: string,
  since: Date | null,
) {
  const workflows = new WorkflowsService(repos.db, scope);
  const row = await workflows.findFirst({ where: { id: workflowId }, columns: { id: true, failingSince: true } });
  if (!row) return;
  const starts = since !== null && !row.failingSince;
  const ends = since === null && row.failingSince !== null;
  if (starts || ends) await workflows.updateActivity(row.id, { failingSince: since });
}

/**
 * A finished or cancelled run frees a place: start the oldest run that waits for one, if any. The
 * run is locked while its job is written, so two runs that finish at once start two others.
 */
export async function wakeNext(
  repos: Pick<Repositories, "transaction">,
  scope: { workspaceId: string; environmentId: string },
  workflowId: string,
  now: Date,
) {
  await repos.transaction(async (tx) => {
    if ((await new WorkflowRunsService(tx.db, scope).countOpen(workflowId)) >= MAX_OPEN_RUNS) return;
    const next = await takeNextQueued(tx.db, scope, workflowId);
    if (next) await enqueueRunJob(tx, { id: next, segment: 0 }, scope, now, now);
  });
}

async function execList(
  deps: WorkflowRunnerDeps,
  exec: Execution,
  steps: WorkflowStepDef[],
  prefix: string,
  vars: Variables,
  ctx: Omit<Parameters<typeof runStep>[2], "path">,
): Promise<void> {
  for (const step of steps) {
    if (exec.stop) return;
    if (Date.now() > exec.budgetEnd) {
      exec.stop = { kind: "budget" };
      return;
    }
    const path = prefix ? `${prefix}.${step.id}` : step.id;
    const terms: Term[] = [];
    const here: Variables = Object.assign({ ...vars, steps: exec.outputs() }, { [TERMS]: terms });
    const done = exec.entry(path);
    const record = (fields: EntryFields, options?: Parameters<Execution["record"]>[3]) =>
      exec.record(step, path, { ...fields, ...termsOf(terms) }, options);
    try {
      if (step.type === "condition") {
        // Logged before its branch, so the log is in the order things happened, and a run that
        // goes on later takes the branch it took then.
        const logged = done?.status === "done" ? (done.output as { branch?: unknown } | undefined)?.branch : undefined;
        const branch =
          logged === "then" || logged === "else"
            ? logged
            : evaluateCondition(String(step.when), here)
              ? "then"
              : "else";
        if (!done) await record({ status: "done", input: stepInput(step, here), output: { branch } });
        await execList(deps, exec, (step[branch] as WorkflowStepDef[] | undefined) ?? [], path, here, ctx);
        if (exec.stop) return;
      } else if (step.type === "answer") {
        if (done?.status === "done") continue;
        const value = step.value === undefined ? null : resolveValue(step.value, here);
        await record({ status: "done", output: value, finished: stamp() }, { runOutput: { value } });
        exec.answered = true;
        if (exec.mode.stopAtAnswer || exec.mode.decision) exec.stop = { kind: "answered" };
      } else if (step.type === "return") {
        const value =
          done?.status === "done" ? done.output : step.value === undefined ? null : resolveValue(step.value, here);
        if (!done) await record({ status: "done", output: value, finished: stamp() });
        exec.stop = { kind: "returned", value };
      } else if (step.type === "filter") {
        if (done?.status === "done") continue;
        const passed = evaluateCondition(String(step.when), here);
        await record({ status: "done", input: stepInput(step, here), output: { passed } });
        if (!passed) exec.stop = { kind: "filtered" };
      } else if (step.type === "loop") {
        if (done?.status === "done") continue;
        const over = evaluate(String(step.over), here);
        if (!Array.isArray(over)) throw new StepFailure(`"over" gave ${JSON.stringify(over)}, not a list`);
        if (over.length > MAX_LOOP) throw new StepFailure(`a loop runs at most ${MAX_LOOP} times`);
        const inner = (step.steps as WorkflowStepDef[] | undefined) ?? [];
        const outputs: unknown[] = [];
        for (const [index, item] of over.entries()) {
          await execList(deps, exec, inner, `${path}[${index}]`, { ...here, item, index }, ctx);
          if (exec.stop) return;
          const last = inner.at(-1);
          outputs.push(last ? exec.entry(`${path}[${index}].${last.id}`)?.output : undefined);
        }
        await record({ status: "done", input: stepInput(step, here), output: outputs });
      } else if (step.type === "delay") {
        if (done?.status === "done") continue;
        const wakeAt = done?.wake
          ? new Date(done.wake)
          : typeof step.for === "string"
            ? new Date(Date.now() + (parseDuration(step.for) ?? Number.NaN))
            : new Date(String(resolveValue(step.until, here)));
        if (Number.isNaN(wakeAt.getTime())) throw new StepFailure("the delay does not give a time");
        if (wakeAt.getTime() - exec.runStarted.getTime() > MAX_RUN_MS)
          throw new StepFailure("a run lasts at most 30 days, delays included");
        if (Date.now() >= wakeAt.getTime()) {
          await record({ status: "done", wake: wakeAt.toISOString(), finished: stamp() });
        } else {
          await record({ status: "waiting", wake: wakeAt.toISOString() });
          exec.stop = { kind: "delay", at: wakeAt };
        }
      } else {
        if (done?.status === "done") continue;
        const attempt = (done?.attempt ?? 0) + 1;
        // Before its answer, a decision cannot wait for a retry.
        const maxAttempts =
          exec.mode.decision && !exec.answered
            ? 1
            : Math.min(5, Math.max(1, Number((step.retry as { attempts?: number } | undefined)?.attempts ?? 3)));
        let read: unknown;
        const reads = { onRead: (value: unknown) => void (read = value) };
        const input = stepInput(step, here);
        const withRead = () => ({ ...(input ? { input } : {}), ...(read === undefined ? {} : { read }) });
        try {
          // A record write and its checkpoint are one transaction: the write happens once.
          if (step.type.startsWith("record.") || step.type.startsWith("case.") || step.type.startsWith("list.")) {
            await deps.repos.transaction(async (tx) => {
              const output = await runStep(step, here, { ...ctx, ...reads, repos: tx, path });
              await record(
                { status: "done", attempt, output, ...withRead(), error: null, finished: stamp() },
                { db: tx.db },
              );
            });
          } else {
            const output = await runStep(step, here, { ...ctx, ...reads, path });
            await record({ status: "done", attempt, output, ...withRead(), error: null, finished: stamp() });
          }
        } catch (cause) {
          if (cause instanceof RunCancelled) throw cause;
          const failure =
            cause instanceof StepFailure
              ? cause
              : new StepFailure((cause as Error).message, !(cause instanceof ExpressionError));
          if (attempt < maxAttempts && failure.retryable) {
            await record({ status: "failed", attempt, ...withRead(), error: failure.message });
            exec.stop = { kind: "retry", at: new Date(Date.now() + RETRY_BACKOFF_MS[attempt - 1]!) };
          } else if (step.on_fail === "continue") {
            await record({ status: "done", attempt, ...withRead(), output: { error: failure.message } });
          } else {
            await record({ status: "failed", attempt, ...withRead(), error: failure.message });
            exec.stop = { kind: "failed", error: `Step '${step.name}' failed: ${failure.message}` };
          }
        }
      }
    } catch (cause) {
      if (cause instanceof RunCancelled) throw cause;
      // A failure outside a leaf step: a bad condition, a bad loop, a bad delay.
      if (exec.stop) return;
      const failure = cause instanceof StepFailure ? cause : new StepFailure((cause as Error).message);
      exec.stop = { kind: "failed", error: `Step '${step.name}' failed: ${failure.message}` };
    }
  }
}
