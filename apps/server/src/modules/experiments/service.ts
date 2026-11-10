import {
  loadLogistic,
  loadXgboost,
  trainGbdt,
  triggerOf,
  type Decider,
  type GbdtParams,
  type XgboostModel,
} from "@kairos/core";
import type { Executor } from "../../platform/database";
import { AppError, invalid, notFound } from "../../platform/error";
import { PermanentError, type ModuleJobs } from "../../platform/jobs/worker";
import { ActionsService } from "../../services/action.service";
import { JobsService } from "../../services/job.service";
import { openSteps, WorkflowsService } from "../../services/workflow.service";
import {
  toExperimentView,
  WorkflowExperimentsService,
  type ExperimentView,
} from "../../services/workflow_experiment.service";
import { uploadVersion } from "../models";
import {
  checkModels,
  collectTrainingRows,
  saveDraft,
  saveWorkflow,
  validateWorkflow,
  type TrainingRow,
} from "../workflows";
import {
  averagePrecision,
  backtestBatch,
  backtestReport,
  type BacktestState,
  bootstrapGain,
  fitLogistic,
  rates,
  readsRemoved,
  removedSteps,
  rocAuc,
  thresholdFor,
  transform,
  variantSteps,
} from "./libs";
import type { ExperimentBody, ExperimentVariant, RenameBody } from "./schema";

type Scope = { workspaceId: string; environmentId: string };

export const EXPERIMENT_JOB = "experiments.run";
const MIN_ROWS = 100;
const MAX_ROWS = 100_000;
const SAMPLES = 200;
const LEASE_MS = 20 * 60_000;
/** A backtest replays for this long in one job, then goes on in the next. */
const BACKTEST_BUDGET_MS = 10 * 60_000;

/** What a backtest needs to run the workflow: its model calls. */
export interface ExperimentRuntime {
  decider: Decider;
  allowPrivate: boolean;
}

const conflict = (message: string) => new AppError("conflict", "conflict", message);

export async function createExperiment(
  db: Executor,
  scope: Scope,
  workflow: string,
  body: ExperimentBody,
  by: string | null,
  now: Date,
): Promise<ExperimentView> {
  const current = await new WorkflowsService(db, scope).findByName(workflow);
  if (!current) throw notFound(`No workflow "${workflow}"`);
  if (body.backtest) {
    const trigger = current.draft?.trigger ?? current.trigger;
    if (trigger.type !== "decision")
      throw invalid("backtest: a backtest replays the decision requests of a decision workflow");
    const action = await new ActionsService(db, scope).findLatest(String(trigger.action));
    if (action && !triggerOf(action))
      throw invalid(
        `backtest: the action "${action.name}" has no trigger event, so there are no past requests to replay. Set its trigger first.`,
      );
  }
  if (current.trigger.type !== "decision" && !body.subject)
    throw invalid(
      'subject: the entity each run is about, as { "type": "user", "id": "{{ … }}" }, for a workflow that makes no decisions',
    );
  return db.transaction(async (tx) => {
    const row = await new WorkflowExperimentsService(tx, scope).create(
      {
        workflow,
        baseVersion: current.version > 0 ? current.version : null,
        status: "queued",
        config: body as unknown as Record<string, unknown>,
        createdBy: by,
      },
      now,
    );
    await new JobsService(tx).enqueue({ kind: EXPERIMENT_JOB, key: row.id, payload: { id: row.id }, ...scope }, now);
    return toExperimentView(row);
  });
}

export async function listExperiments(db: Executor, scope: Scope, workflow?: string) {
  const rows = await new WorkflowExperimentsService(db, scope).findMany({
    where: workflow ? { workflow } : {},
    orderBy: { created: "desc" },
    limit: 100,
  });
  return rows.map((r) => toExperimentView(r, false));
}

export async function getExperiment(db: Executor, scope: Scope, id: string) {
  const row = await new WorkflowExperimentsService(db, scope).findFirst({ where: { id } });
  if (!row) throw notFound(`No experiment "${id}"`);
  return row;
}

/** Renames the experiment or its variants. Names are labels: the keys, models and steps stay. */
export async function renameExperiment(db: Executor, scope: Scope, id: string, body: RenameBody, now: Date) {
  return db.transaction(async (tx) => {
    const experiments = new WorkflowExperimentsService(tx, scope);
    await experiments.lock(id);
    const row = await getExperiment(tx, scope, id);
    const names = body.variants ?? {};
    const variants = (row.config.variants ?? []) as { key: string; name: string }[];
    const unknown = Object.keys(names).filter((key) => !variants.some((v) => v.key === key));
    if (unknown.length)
      throw invalid(`variants: the experiment has no variant ${unknown.map((k) => `"${k}"`).join(", ")}`);
    const renamed = <T extends Record<string, unknown>>(v: T) =>
      typeof v.key === "string" && names[v.key] !== undefined ? { ...v, name: names[v.key] } : v;
    const [saved] = await experiments.updateMany(
      { id },
      {
        config: {
          ...row.config,
          ...(body.name !== undefined ? { name: body.name } : {}),
          variants: variants.map(renamed),
        },
        ...(row.results ? { results: row.results.map(renamed) } : {}),
      },
      now,
    );
    return toExperimentView(saved!);
  });
}

interface Split {
  train: number[];
  valid: number[];
  test: number[];
}

/** The oldest rows train, the next validate and the newest test, as the model will meet new rows. */
function splitByTime(rows: TrainingRow[], train: number, valid: number): Split {
  const order = rows
    .map((_, i) => i)
    .sort((a, b) => rows[a]!.at.getTime() - rows[b]!.at.getTime() || rows[a]!.run.localeCompare(rows[b]!.run));
  const a = Math.floor(order.length * train);
  const b = Math.floor(order.length * (train + valid));
  return { train: order.slice(0, a), valid: order.slice(a, b), test: order.slice(b) };
}

interface Scored {
  /** One score for each row of the data, in its order. */
  scores: Float64Array;
  models: {
    model?: { slug: string; body: Record<string, unknown> };
    base?: { slug: string; body: Record<string, unknown> };
  };
  notes: Record<string, unknown>;
}

function gbdt(names: string[], rows: TrainingRow[], columns: number[], fit: number[], params: GbdtParams | undefined) {
  // Early stopping watches the newest part of the rows it fits, never the validation rows.
  const cut = Math.max(1, Math.floor(fit.length * 0.85));
  const pick = (idx: number[]) => ({
    rows: idx.map((i) => columns.map((c) => rows[i]!.values[c]!)),
    labels: idx.map((i) => rows[i]!.label),
  });
  const trained = trainGbdt(names, pick(fit.slice(0, cut)), pick(fit.slice(cut)), params);
  const loaded = loadXgboost(trained.model);
  if (!loaded.model) throw new PermanentError(`The trained model could not be read: ${loaded.problems.join("; ")}`);
  return { body: trained.model, scorer: loaded.model, trees: trained.trees };
}

function scoreAll(scorer: XgboostModel, rows: Float64Array[]) {
  return Float64Array.from(rows, (row) => scorer.score(row));
}

function samplesOf(names: string[], inputs: Float64Array[], scorer: XgboostModel) {
  const step = Math.max(1, Math.floor(inputs.length / SAMPLES));
  const picked: Record<string, unknown>[] = [];
  for (let i = 0; i < inputs.length && picked.length < SAMPLES; i += step) {
    const row = inputs[i]!;
    picked.push({
      features: Object.fromEntries(names.map((n, c) => [n, Number.isNaN(row[c]!) ? null : row[c]!])),
      score: scorer.score(row),
    });
  }
  return picked;
}

function logisticLayer(
  names: string[],
  inputs: Float64Array[],
  labels: number[],
  fitRows: number[],
  transforms: Record<string, "identity" | "logit">,
  l2: number,
) {
  const kinds = names.map((n) => transforms[n] ?? "identity");
  const fill = names.map((_, c) => {
    let sum = 0;
    let count = 0;
    for (const i of fitRows) {
      const v = inputs[i]![c]!;
      if (!Number.isNaN(v)) {
        sum += v;
        count++;
      }
    }
    return count ? sum / count : kinds[c] === "logit" ? 0.5 : 0;
  });
  const columns = names.map((_, c) =>
    Float64Array.from(fitRows, (i) => {
      const v = inputs[i]![c]!;
      return transform(kinds[c]!, Number.isNaN(v) ? fill[c]! : v);
    }),
  );
  const fitted = fitLogistic(
    columns,
    fitRows.map((i) => labels[i]!),
    l2,
  );
  const body = {
    features: names,
    transforms: Object.fromEntries(names.map((n, c) => [n, kinds[c]])),
    coefficients: fitted.coefficients,
    intercept: fitted.intercept,
    fill: Object.fromEntries(names.map((n, c) => [n, fill[c]])),
  };
  const loaded = loadLogistic(body);
  if (!loaded.model) throw new PermanentError(`The logistic model could not be read: ${loaded.problems.join("; ")}`);
  return { body, scorer: loaded.model };
}

function trainVariant(
  variant: ExperimentVariant,
  names: string[],
  rows: TrainingRow[],
  split: Split,
  slugs: { model: string; base: string },
): Scored {
  const m = variant.model;
  const column = (n: string) => names.indexOf(n);
  const labels: number[] = rows.map((r) => r.label);
  const inputsOf = (features: string[]) => rows.map((r) => Float64Array.from(features, (f) => r.values[column(f)]!));

  if (m.type === "probability") {
    const c = column(m.feature);
    return {
      scores: Float64Array.from(rows, (r) => (Number.isNaN(r.values[c]!) ? 0.5 : r.values[c]!)),
      models: {},
      notes: { trained: false },
    };
  }
  if (m.type === "gbdt") {
    const g = gbdt(m.features, rows, m.features.map(column), split.train, m.params);
    const inputs = inputsOf(m.features);
    return {
      scores: scoreAll(g.scorer, inputs),
      models: {
        model: {
          slug: slugs.model,
          body: { format: "xgboost-json", model: g.body, samples: samplesOf(m.features, inputs, g.scorer) },
        },
      },
      notes: { trees: g.trees, fitted_on: split.train.length },
    };
  }
  if (m.type === "logistic") {
    const inputs = inputsOf(m.features);
    const layer = logisticLayer(m.features, inputs, labels, split.train, m.transforms ?? {}, m.l2 ?? 1e-3);
    return {
      scores: scoreAll(layer.scorer, inputs),
      models: {
        model: {
          slug: slugs.model,
          body: { format: "logistic-json", model: layer.body, samples: samplesOf(m.features, inputs, layer.scorer) },
        },
      },
      notes: { coefficients: Object.fromEntries(m.features.map((f, i) => [f, layer.body.coefficients[i]])) },
    };
  }
  // Stacked: the base model fits the older part of the training rows, and the layer fits the newer
  // part, on scores the base model did not train on.
  const cut = Math.floor(split.train.length * 0.7);
  const baseFit = split.train.slice(0, cut);
  const layerFit = split.train.slice(cut);
  for (const [part, idx] of [
    ["base model", baseFit],
    ["stacking layer", layerFit],
  ] as const) {
    const positives = idx.reduce((n, i) => n + labels[i]!, 0);
    if (positives === 0 || positives === idx.length)
      throw new Error(`The rows the ${part} fits need both outcomes: ${positives} of ${idx.length} are positive`);
  }
  const base = gbdt(m.base.features, rows, m.base.features.map(column), baseFit, m.base.params);
  const baseInputs = inputsOf(m.base.features);
  const baseScores = scoreAll(base.scorer, baseInputs);
  const layerNames = ["base", ...m.features];
  const layerInputs = rows.map((r, i) =>
    Float64Array.from(layerNames, (f) => (f === "base" ? baseScores[i]! : r.values[column(f)]!)),
  );
  const layer = logisticLayer(
    layerNames,
    layerInputs,
    labels,
    layerFit,
    { base: "logit", ...(m.transforms ?? {}) },
    m.l2 ?? 1e-3,
  );
  return {
    scores: scoreAll(layer.scorer, layerInputs),
    models: {
      base: {
        slug: slugs.base,
        body: {
          format: "xgboost-json",
          model: base.body,
          samples: samplesOf(m.base.features, baseInputs, base.scorer),
        },
      },
      model: {
        slug: slugs.model,
        body: { format: "logistic-json", model: layer.body, samples: samplesOf(layerNames, layerInputs, layer.scorer) },
      },
    },
    notes: {
      trees: base.trees,
      base_fitted_on: baseFit.length,
      layer_fitted_on: layerFit.length,
      coefficients: Object.fromEntries(layerNames.map((f, i) => [f, layer.body.coefficients[i]])),
    },
  };
}

const at = (idx: number[], values: ArrayLike<number>) => Float64Array.from(idx, (i) => values[i]!);

function measure(idx: number[], labels: number[], scores: Float64Array) {
  const y = at(idx, labels);
  const s = at(idx, scores);
  let positives = 0;
  for (const v of y) positives += v;
  return { rows: idx.length, positives, roc_auc: rocAuc(y, s), pr_auc: averagePrecision(y, s) };
}

/**
 * A slug of the experiment's own: an upload to a slug that workflows already use would make it
 * their latest version, and change their scores with no apply.
 */
export function slugFor(prefix: string, key: string, id: string) {
  const tail = id
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `${`${prefix}-${key}`.slice(0, 63 - tail.length).replace(/-+$/, "")}-${tail}`;
}

const featuresOf = (model: ExperimentVariant["model"]) =>
  model.type === "probability"
    ? [model.feature]
    : model.type === "stacked"
      ? [...model.base.features, ...model.features]
      : model.features;

const prefixOf = (workflow: string) =>
  workflow
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workflow";

/**
 * Trains, validates and tests each variant, uploads its models, and writes its steps. `last`: no
 * retry follows, so an error fails the experiment; before that, it waits queued for the retry.
 */
export async function runExperiment(
  db: Executor,
  scope: Scope,
  id: string,
  now: () => Date,
  attempt: { last: boolean } = { last: true },
  runtime?: ExperimentRuntime,
): Promise<void> {
  const experiments = new WorkflowExperimentsService(db, scope);
  const row = await getExperiment(db, scope, id);
  if (row.status === "done" || row.status === "failed") return;
  // One run at a time: a second claim of the job finds it running, unless that run's lease ran out.
  const stale = row.status === "running" && (!row.started || now().getTime() - row.started.getTime() > LEASE_MS);
  const [claimed] = await experiments.updateMany(
    stale ? { id, status: "running" } : { id, status: "queued" },
    { status: "running", started: now(), error: null },
    now(),
  );
  if (!claimed) return;
  try {
    const config = row.config as unknown as ExperimentBody;
    let state: BacktestState | null = null;
    let report: Awaited<ReturnType<typeof backtestReport>> | null = null;
    if (config.backtest) {
      if (!runtime) throw new Error("this process cannot run a backtest: it has no model client");
      const progress = row.dataset as { backtest_state?: BacktestState; batches?: number } | null;
      state = await backtestBatch(
        { db, ...runtime, now },
        scope,
        { id, workflow: row.workflow, config: config.backtest },
        progress?.backtest_state ?? null,
        BACKTEST_BUDGET_MS,
      );
      if (!state.done) {
        const batches = (progress?.batches ?? 0) + 1;
        await db.transaction(async (tx) => {
          await new WorkflowExperimentsService(tx, scope).updateMany(
            { id },
            { status: "queued", dataset: { backtest_state: state, batches } },
            now(),
          );
          await new JobsService(tx).enqueue(
            { kind: EXPERIMENT_JOB, key: `${id}:${batches}`, payload: { id }, ...scope },
            now(),
          );
        });
        return;
      }
      report = await backtestReport(
        db,
        scope,
        { id, workflow: row.workflow },
        state,
        { labels: config.labels, window: config.window },
        now(),
      );
    }
    // A backtest that cannot train still answers what the workflow would have decided.
    const finishUntrained = async (reason: string | null, extra: Record<string, unknown> = {}) => {
      await experiments.updateMany(
        { id },
        {
          status: "done",
          finished: now(),
          best: null,
          results: [],
          dataset: {
            ...extra,
            labels: config.labels,
            window: config.window,
            not_trained: reason,
            backtest: report,
            ran_on: state!.ran_on,
            workflow_version: (await new WorkflowsService(db, scope).findByName(row.workflow))?.version ?? null,
          },
        },
        now(),
      );
    };
    if (report && config.variants.length === 0) return await finishUntrained(null);
    const data = await collectTrainingRows(
      db,
      scope,
      row.workflow,
      {
        features: config.features,
        labels: config.labels,
        window: config.window,
        ...(config.subject ? { subject: config.subject } : {}),
        ...(config.from ? { from: config.from } : {}),
        ...(config.to ? { to: config.to } : {}),
        limit: MAX_ROWS,
        newest: true,
        ...(config.backtest ? { backtest: id } : {}),
      },
      now(),
    );
    const { rows, names } = data;
    const cannotTrain = async (reason: string) => {
      if (!report) throw new PermanentError(reason);
      await finishUntrained(reason, { rows: rows.length, export: data.counts });
    };
    if (rows.length < MIN_ROWS)
      return await cannotTrain(`${rows.length} labeled runs: an experiment needs at least ${MIN_ROWS}`);
    const split = splitByTime(rows, config.split.train, config.split.valid);
    const labels: number[] = rows.map((r) => r.label);
    for (const [part, idx] of Object.entries(split) as [string, number[]][]) {
      const positives = idx.reduce((n, i) => n + labels[i]!, 0);
      if (positives === 0 || positives === idx.length)
        return await cannotTrain(`The ${part} rows need both outcomes: ${positives} of ${idx.length} are positive`);
    }

    const current = await new WorkflowsService(db, scope).findByName(row.workflow);
    if (!current) throw new PermanentError(`No workflow "${row.workflow}"`);
    // A backtest of the draft builds the variants on the steps it ran.
    const workflow =
      state?.ran_on === "draft" && state.definition
        ? {
            ...current,
            trigger: state.definition.trigger,
            steps: openSteps(state.definition.steps, scope.workspaceId),
          }
        : current;
    const prefix = config.model_prefix ?? prefixOf(row.workflow);
    const failed: { key: string; error: string }[] = [];
    const trained = config.variants.flatMap((variant) => {
      try {
        const slugs = { model: slugFor(prefix, variant.key, id), base: slugFor(prefix, `${variant.key}-base`, id) };
        return [{ variant, ...trainVariant(variant, names, rows, split, slugs) }];
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failed.push({ key: variant.key, error: error.message.slice(0, 500) });
        return [];
      }
    });
    if (!trained.length)
      throw new PermanentError(`No variant could be trained: ${failed.map((f) => `${f.key}: ${f.error}`).join("; ")}`);
    const baselineKey = config.baseline ?? config.variants[0]!.key;
    const baseline = trained.find((t) => t.variant.key === baselineKey);
    const testLabels = at(split.test, labels);

    const results: Record<string, unknown>[] = [];
    for (const t of trained) {
      const refs: { model?: string; base?: string } = {};
      for (const role of ["base", "model"] as const) {
        const made = t.models[role];
        if (!made) continue;
        const uploaded = await uploadVersion(
          db,
          scope,
          made.slug,
          {
            ...made.body,
            name: role === "base" ? `${t.variant.name} (base)` : t.variant.name,
            description: `Experiment ${id} on ${row.workflow}`,
            training: { experiment: id, workflow: row.workflow, ...t.notes },
          } as never,
          now(),
          row.createdBy,
        );
        refs[role] = `${made.slug}@${uploaded.version}`;
      }
      const validScores = at(split.valid, t.scores);
      const thresholds = {
        review: thresholdFor(validScores, config.review_rate),
        block: thresholdFor(validScores, config.block_rate),
      };
      const testScores = at(split.test, t.scores);
      const valid = measure(split.valid, labels, t.scores);
      const test = measure(split.test, labels, t.scores);
      const gain =
        !baseline || t === baseline || test.roc_auc === null
          ? null
          : (() => {
              const baseScores = at(split.test, baseline.scores);
              const base = {
                roc_auc: rocAuc(testLabels, baseScores),
                pr_auc: averagePrecision(testLabels, baseScores),
              };
              return {
                vs: baselineKey,
                roc_auc: base.roc_auc === null ? null : test.roc_auc - base.roc_auc,
                pr_auc: base.pr_auc === null || test.pr_auc === null ? null : test.pr_auc - base.pr_auc,
                ci95: bootstrapGain(testLabels, testScores, baseScores),
              };
            })();
      const steps = variantSteps(
        workflow.steps as Record<string, unknown>[],
        t.variant,
        config.features,
        refs,
        thresholds,
      );
      const problems = validateWorkflow({ name: row.workflow, trigger: workflow.trigger, steps } as never);
      if (!problems.length) await checkModels(db, scope, steps).catch((error: Error) => problems.push(error.message));
      const removed = removedSteps(workflow.steps as Record<string, unknown>[], t.variant);
      const reads = readsRemoved(config.features, featuresOf(t.variant.model), removed);
      if (reads.length)
        problems.push(
          `${reads.join(", ")} read steps that the variant removes: in production they would have no value`,
        );
      if (t.variant.model.type === "probability") {
        const c = names.indexOf(t.variant.model.feature);
        const missing = rows.filter((r) => Number.isNaN(r.values[c]!)).length;
        if (missing)
          problems.push(
            `${t.variant.model.feature} has no value in ${missing} of ${rows.length} runs: its steps cannot score those runs`,
          );
      }
      results.push({
        key: t.variant.key,
        name: t.variant.name,
        description: t.variant.description,
        model: t.variant.model,
        drop_steps: t.variant.drop_steps,
        removed_steps: removed,
        models: refs,
        metrics: {
          valid,
          test,
          gain,
          thresholds,
          at_review: rates(testLabels, testScores, thresholds.review),
          at_block: rates(testLabels, testScores, thresholds.block),
        },
        notes: t.notes,
        steps,
        problems,
      });
    }
    const metric = config.metric;
    const best = results
      .filter((r) => !(r.problems as string[]).length)
      .reduce<Record<string, unknown> | null>((top, r) => {
        const score = ((r.metrics as any).valid[metric] as number | null) ?? -1;
        const topScore = top ? (((top.metrics as any).valid[metric] as number | null) ?? -1) : -2;
        return score > topScore ? r : top;
      }, null);
    const times = rows.map((r) => r.at.getTime()).sort((a, b) => a - b);
    await experiments.updateMany(
      { id },
      {
        status: "done",
        finished: now(),
        best: (best?.key as string | undefined) ?? null,
        results,
        dataset: {
          rows: rows.length,
          positives: labels.reduce((a, b) => a + b, 0),
          from: new Date(times[0]!).toISOString(),
          to: new Date(times.at(-1)!).toISOString(),
          labels: config.labels,
          window: config.window,
          split: { train: split.train.length, valid: split.valid.length, test: split.test.length },
          export: data.counts,
          metric,
          baseline: baselineKey,
          workflow_version: workflow.version,
          ...(report ? { backtest: report, ran_on: state!.ran_on } : {}),
          ...(failed.length ? { failed } : {}),
        },
      },
      now(),
    );
  } catch (error) {
    // A request that is wrong, such as a workflow or a label that is not there, fails the same way again.
    const permanent = error instanceof PermanentError || error instanceof AppError;
    const message = (error as Error).message.slice(0, 2000);
    await experiments.updateMany(
      { id },
      permanent || attempt.last
        ? { status: "failed", finished: now(), error: message }
        : { status: "queued", error: message },
      now(),
    );
    if (!permanent) throw error;
  }
}

/**
 * Records the choice of a variant, with why, and writes its steps as the draft or the next version.
 * Once for each experiment, and only on the version it ran on: its steps are that version's steps.
 */
export async function applyExperiment(
  db: Executor,
  scope: Scope,
  id: string,
  choice: { variant: string; reason?: string; publish: boolean },
  by: string | null,
  now: Date,
) {
  return db.transaction(async (tx) => {
    await new WorkflowExperimentsService(tx, scope).lock(id);
    const row = await getExperiment(tx, scope, id);
    if (row.status !== "done") throw invalid(`the experiment is ${row.status}: apply a variant when it is done`);
    if (row.applied)
      throw conflict(
        `variant "${row.applied.variant}" of this experiment was applied at ${row.applied.at}: run a new experiment to apply another`,
      );
    const result = row.results?.find((r) => r.key === choice.variant) as
      { steps: Record<string, unknown>[]; problems: string[] } | undefined;
    if (!result) throw invalid(`variant: the experiment has no variant "${choice.variant}"`);
    if (result.problems.length) throw invalid(`The variant's steps cannot be saved: ${result.problems.join("; ")}`);
    const current = await new WorkflowsService(tx, scope).findByName(row.workflow);
    if (!current) throw notFound(`No workflow "${row.workflow}"`);
    const ranOn = (row.dataset as { workflow_version?: number } | null)?.workflow_version;
    if (ranOn !== undefined && current.version !== ranOn)
      throw conflict(
        `The workflow is at version ${current.version}, and the experiment ran on version ${ranOn}: run the experiment again`,
      );
    const ranOnDraft = (row.dataset as { ran_on?: unknown } | null)?.ran_on === "draft";
    if (!choice.publish && current.draft && !ranOnDraft)
      throw conflict("The workflow has a draft: publish or discard it before you apply a variant as a draft");
    const definition = {
      name: row.workflow,
      displayName: current.displayName ?? undefined,
      trigger: current.trigger,
      steps: result.steps,
    } as never;
    const workflow = choice.publish
      ? await saveWorkflow(tx, scope, definition, by, now)
      : await saveDraft(tx, scope, definition, now);
    const at = now.toISOString();
    const [saved] = await new WorkflowExperimentsService(tx, scope).updateMany(
      { id },
      {
        selected: { variant: choice.variant, reason: choice.reason ?? null, by, at },
        applied: {
          variant: choice.variant,
          version: choice.publish ? workflow.version : null,
          published: choice.publish,
          at,
        },
      },
      now,
    );
    return { experiment: toExperimentView(saved!), workflow };
  });
}

export function experimentJobs({
  db,
  now,
  runtime,
}: {
  db: Executor;
  now: () => Date;
  runtime?: ExperimentRuntime;
}): ModuleJobs {
  return {
    kinds: [
      {
        kind: EXPERIMENT_JOB,
        concurrency: 1,
        retryDelaysMs: [60_000],
        timeoutMs: 15 * 60_000,
        leaseMs: LEASE_MS,
        async run(payload: { id: string }, job) {
          if (!job.workspaceId || !job.environmentId) throw new PermanentError("the job has no environment");
          await runExperiment(
            db,
            { workspaceId: job.workspaceId, environmentId: job.environmentId },
            payload.id,
            now,
            {
              last: job.retryAt === undefined,
            },
            runtime,
          );
        },
      },
    ],
  };
}
