import type { Experiment, ExperimentMetric, ExperimentResult, VariantModel } from "../types/interfaces";
import { dayOf } from "./format";
import { metric, signed } from "./models";

export const METRIC_LABEL: Record<ExperimentMetric, string> = { roc_auc: "ROC-AUC", pr_auc: "PR-AUC" };

export const metricLabel = (m: string | undefined) => METRIC_LABEL[m as ExperimentMetric] ?? m ?? "ROC-AUC";

export const metricOf = (experiment: Pick<Experiment, "config" | "dataset">): ExperimentMetric =>
  experiment.dataset?.metric ?? experiment.config.metric ?? "roc_auc";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function structureOf(model: VariantModel): string {
  switch (model.type) {
    case "gbdt":
      return `Trees · ${count(model.features.length, "field")}`;
    case "logistic":
      return `Logistic · ${count(model.features.length, "field")}`;
    case "stacked": {
      const trees = `Trees on ${count(model.base.features.length, "field")}`;
      return model.features.length ? `${trees} → stacked with ${model.features.length}` : `${trees} → logistic`;
    }
    case "probability":
      return `Probability · ${model.feature}`;
    default:
      return (model as { type: string }).type;
  }
}

export const POLL_MS = 3000;

export const isPending = (experiment: Pick<Experiment, "status">) =>
  experiment.status === "queued" || experiment.status === "running";

export const STATUS_TEXT: Record<Experiment["status"], string> = {
  queued: "Queued",
  running: "Running…",
  done: "Done",
  failed: "Failed",
};

export const statusChip = (status: Experiment["status"]) =>
  status === "done" ? "chip ok" : status === "failed" ? "chip warn" : "chip accent";

export const experimentName = (experiment: Pick<Experiment, "config" | "created_at">) =>
  experiment.config.name ?? `Experiment ${dayOf(experiment.created_at)}`;

export const baselineOf = (experiment: Pick<Experiment, "config" | "dataset">) =>
  experiment.dataset?.baseline ?? experiment.config.baseline ?? experiment.config.variants[0]?.key ?? "";

/** "+0.031 [+0.012, +0.050]"; `better` when the whole interval is above zero. */
export function gainOf(
  result: Pick<ExperimentResult, "key" | "metrics">,
  baseline: string,
): { text: string; better: boolean; baseline: boolean } {
  if (result.key === baseline) return { text: "Baseline", better: false, baseline: true };
  const gain = result.metrics.gain;
  if (!gain || gain.roc_auc === null) return { text: "—", better: false, baseline: false };
  const [low, high] = gain.ci95;
  const interval = low === null && high === null ? "" : ` [${signed(low)}, ${signed(high)}]`;
  return { text: `${signed(gain.roc_auc)}${interval}`, better: low !== null && low > 0, baseline: false };
}

export const rateText = (precision: number | null, recall: number | null) => `${metric(precision)} / ${metric(recall)}`;

export function appliedText(applied: Experiment["applied"]): string {
  if (!applied) return "Not applied";
  if (applied.published) return applied.version === null ? "Published" : `Published v${applied.version}`;
  return "Draft";
}

export const appliedBadge = (applied: NonNullable<Experiment["applied"]>) =>
  applied.published && applied.version !== null ? `Applied v${applied.version}` : "Applied as draft";

export const periodOf = (dataset: Pick<NonNullable<Experiment["dataset"]>, "from" | "to">) =>
  `${dayOf(dataset.from)} – ${dayOf(dataset.to)}`;

export const resultOf = (experiment: Pick<Experiment, "results">, key: string | null | undefined) =>
  key ? experiment.results?.find((r) => r.key === key) : undefined;

export const validMetric = (result: ExperimentResult, m: ExperimentMetric) => result.metrics.valid[m];
export const testMetric = (result: ExperimentResult, m: ExperimentMetric) => result.metrics.test[m];

/** The features a variant reads, each with its transform when it is not the identity. */
export function featuresOf(model: VariantModel): { trees: string[]; layer: string[] } {
  const tagged = (features: string[], transforms?: Record<string, string>) =>
    features.map((f) => (transforms?.[f] && transforms[f] !== "identity" ? `${f} (${transforms[f]})` : f));
  switch (model.type) {
    case "gbdt":
      return { trees: model.features, layer: [] };
    case "logistic":
      return { trees: [], layer: tagged(model.features, model.transforms) };
    case "stacked":
      return { trees: model.base.features, layer: tagged(model.features, model.transforms) };
    case "probability":
      return { trees: [], layer: [model.feature] };
  }
}

export function coefficientsOf(notes: Record<string, unknown>): [string, number][] {
  const c = notes.coefficients;
  if (!c || typeof c !== "object") return [];
  return Object.entries(c as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number");
}
