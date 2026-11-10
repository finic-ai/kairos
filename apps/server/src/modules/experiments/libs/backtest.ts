import { triggerOf, type Decider } from "@kairos/core";
import type { Executor } from "../../../platform/database";
import { PermanentError } from "../../../platform/jobs/worker";
import { createRepositories } from "../../../repositories";
import { ActionsService } from "../../../services/action.service";
import { EventsService } from "../../../services/event.service";
import { LabelsService } from "../../../services/label.service";
import {
  backtestKeyPrefix,
  sealSteps,
  WorkflowRunsService,
  WorkflowsService,
} from "../../../services/workflow.service";
import { startRun } from "../../workflows";
import { executeRun, outcomeOf, parseDuration } from "../../workflows/libs";

type Scope = { workspaceId: string; environmentId: string };

const PAGE = 50;
const PARALLEL = 4;
/** One run's time to its answer: a model step can take seconds. */
const RUN_BUDGET_MS = 30_000;
const FLAGGED = 100;
const ERRORS = 5;

export interface BacktestConfig {
  from?: string;
  to?: string;
  limit?: number;
}

/** Where a backtest is, kept on the experiment between its jobs. */
export interface BacktestState {
  /** The draft's steps as they were when the backtest started, or the live version it ran. */
  ran_on: "draft" | number;
  definition?: { trigger: Record<string, unknown>; steps: Record<string, unknown>[] };
  action: string;
  subject: string;
  total: number;
  runs: number;
  skipped: number;
  cursor: { ts: string; id: string } | null;
  done: boolean;
}

export interface BacktestDeps {
  db: Executor;
  decider: Decider;
  allowPrivate: boolean;
  now: () => Date;
}

async function prepare(db: Executor, scope: Scope, workflowName: string, config: BacktestConfig) {
  const workflow = await new WorkflowsService(db, scope).findByName(workflowName);
  if (!workflow) throw new PermanentError(`No workflow "${workflowName}"`);
  const trigger = workflow.draft?.trigger ?? workflow.trigger;
  if (trigger.type !== "decision")
    throw new PermanentError("A backtest replays the decision requests of a decision workflow");
  const action = await new ActionsService(db, scope).findLatest(String(trigger.action));
  if (!action) throw new PermanentError(`No action "${String(trigger.action)}"`);
  const fires = triggerOf(action);
  if (!fires)
    throw new PermanentError(
      `The action "${action.name}" has no trigger event, so there are no past requests to replay: set its trigger`,
    );
  if (!workflow.draft && workflow.version === 0) throw new PermanentError("The workflow has no version and no draft");
  const state: BacktestState = {
    ran_on: workflow.draft ? "draft" : workflow.version,
    ...(workflow.draft
      ? { definition: { trigger: workflow.draft.trigger, steps: sealSteps(workflow.draft.steps, scope.workspaceId) } }
      : {}),
    action: action.name,
    subject: action.subject,
    total: Math.min(
      await new EventsService(db, scope).countForBacktest(fires.event, fires.statuses, config),
      config.limit ?? Infinity,
    ),
    runs: 0,
    skipped: 0,
    cursor: null,
    done: false,
  };
  return { workflow, fires, state };
}

/**
 * Replays the past requests of the workflow's action, oldest first, for at most `budgetMs`: each
 * one is a test run of the workflow as of the request's time, so a step that acts only says what
 * it would do, and nothing is decided. A run's key holds the request, so a replay after a crash
 * does not run it twice.
 */
export async function backtestBatch(
  deps: BacktestDeps,
  scope: Scope,
  experiment: { id: string; workflow: string; config: BacktestConfig },
  saved: BacktestState | null,
  budgetMs: number,
): Promise<BacktestState> {
  const { db } = deps;
  const prepared = await prepare(db, scope, experiment.workflow, experiment.config);
  const state = saved ?? prepared.state;
  const { workflow, fires } = prepared;
  const repos = createRepositories(db);
  const runs = new WorkflowRunsService(db, scope);
  const events = new EventsService(db, scope);
  const runner = { repos, decider: deps.decider, now: deps.now, allowPrivate: deps.allowPrivate };
  const deadline = Date.now() + budgetMs;
  const limit = experiment.config.limit ?? Infinity;

  while (!state.done && Date.now() < deadline) {
    const page = await events.listForBacktest(
      fires.event,
      fires.statuses,
      experiment.config,
      state.cursor,
      Math.min(PAGE, limit - state.runs - state.skipped),
    );
    const queue = [...page];
    const one = async () => {
      for (let event = queue.shift(); event; event = queue.shift()) {
        if (!event.entities[state.subject]) {
          state.skipped++;
          continue;
        }
        const run = await startRun(
          repos,
          scope,
          {
            workflowId: workflow.id,
            name: workflow.name,
            version: state.ran_on === "draft" ? 0 : state.ran_on,
            key: `${backtestKeyPrefix(experiment.id)}${event.key}`,
            trigger: {
              action: state.action,
              entities: event.entities,
              properties: event.properties ?? {},
              ...(event.session ? { session: event.session } : {}),
              event_id: event.id,
              ts: event.ts,
            },
            test: true,
            immediate: true,
            noJob: true,
            ...(state.definition ? { definition: state.definition } : {}),
          },
          deps.now(),
        );
        if (run.status === "queued") {
          await executeRun(runner, scope, run.id, 0, { budgetMs: RUN_BUDGET_MS, decision: true });
          // As for a decision as of a past moment: the steps after the answer do not go on.
          await runs.updateMany(
            { id: run.id, status: "waiting" },
            { status: "cancelled", error: "a backtest run stops at its answer", finished: deps.now() },
            deps.now(),
          );
        }
        state.runs++;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, one));
    const last = page.at(-1);
    if (last) state.cursor = { ts: last.ts, id: last.key };
    if (page.length < PAGE || state.runs + state.skipped >= limit) state.done = true;
  }
  return state;
}

type Run = {
  id: string;
  status: string;
  trigger: Record<string, unknown>;
  output: unknown;
  error: string | null;
  steps: unknown;
};

/** What the step log says the model gave, for a workflow whose answer does not repeat it. */
function fromSteps(steps: unknown) {
  const entries = Array.isArray(steps) ? (steps as { output?: Record<string, unknown> }[]) : [];
  for (const e of [...entries].reverse()) {
    const o = e.output;
    if (o && typeof o === "object" && (Array.isArray(o.reasons) || typeof o.risk_score === "number")) return o;
  }
  return {};
}

/**
 * What the workflow would have decided over the backtest: how often each outcome, the reasons,
 * the requests it would have flagged and, with labels, how many of each outcome were labelled
 * within the window after.
 */
export async function backtestReport(
  db: Executor,
  scope: Scope,
  experiment: { id: string; workflow: string },
  state: BacktestState,
  outcomes: { labels: string[]; window: string },
  now: Date,
) {
  const workflow = await new WorkflowsService(db, scope).findByName(experiment.workflow);
  const runs = new WorkflowRunsService(db, scope);
  const all: Run[] = [];
  for (let cursor = ""; workflow;) {
    const page = (await runs.listBacktest(workflow.id, experiment.id, cursor, 1000)) as Run[];
    if (!page.length) break;
    all.push(...page);
    cursor = page.at(-1)!.id;
  }

  const counts: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const errors: { run_id: string; error: string }[] = [];
  const flagged: Record<string, unknown>[] = [];
  const decided: { at: Date; subject: string; outcome: string }[] = [];
  for (const run of all) {
    if (run.status === "failed") {
      counts.failed = (counts.failed ?? 0) + 1;
      if (errors.length < ERRORS) errors.push({ run_id: run.id, error: run.error ?? "failed" });
      continue;
    }
    const answer = (run.output ?? {}) as Record<string, unknown>;
    const outcome = typeof answer.outcome === "string" ? answer.outcome : "none";
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    const model = fromSteps(run.steps);
    const why = (
      Array.isArray(answer.reasons) ? answer.reasons : Array.isArray(model.reasons) ? model.reasons : []
    ) as unknown[];
    for (const r of why) {
      const code =
        typeof r === "string"
          ? r
          : typeof (r as { code?: unknown })?.code === "string"
            ? (r as { code: string }).code
            : null;
      if (code) reasons[code] = (reasons[code] ?? 0) + 1;
    }
    const trigger = run.trigger;
    const subject = String((trigger.entities as Record<string, string> | undefined)?.[state.subject] ?? "");
    decided.push({ at: new Date(String(trigger.ts)), subject, outcome });
    if (outcome === "review" || outcome === "block")
      flagged.push({
        run_id: run.id,
        event_id: trigger.event_id,
        ts: trigger.ts,
        subject: { type: state.subject, id: subject },
        outcome,
        risk_score: answer.risk_score ?? model.risk_score ?? null,
        reasons: why.slice(0, 5),
      });
  }
  const score = (f: Record<string, unknown>) => (typeof f.risk_score === "number" ? f.risk_score : -1);
  flagged.sort((a, b) => score(b) - score(a));

  const windowMs = parseDuration(outcomes.window)!;
  const times = await new LabelsService(db, scope).timesFor(
    state.subject,
    [...new Set(decided.map((d) => d.subject).filter(Boolean))],
    outcomes.labels,
  );
  const labelled: Record<string, { runs: number; labelled: number; unknown: number }> = {};
  for (const d of decided) {
    const o = (labelled[d.outcome] ??= { runs: 0, labelled: 0, unknown: 0 });
    const result = outcomeOf(d.at, times.get(d.subject) ?? [], windowMs, now);
    if (result === "outcome_unknown") o.unknown++;
    else if (result === 1) o.labelled++;
    if (result !== "already_labeled") o.runs++;
  }
  const answered = all.length - (counts.failed ?? 0);
  return {
    ran_on: state.ran_on,
    action: state.action,
    requests: state.total,
    runs: all.length,
    skipped: state.skipped,
    outcomes: counts,
    rates: Object.fromEntries(
      ["approve", "step_up", "review", "block"].map((o) => [o, answered ? (counts[o] ?? 0) / answered : 0]),
    ),
    reasons: Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([code, runs]) => ({ code, runs })),
    labelled,
    flagged: flagged.slice(0, FLAGGED),
    errors,
  };
}
