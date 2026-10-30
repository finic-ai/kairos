import { describe, expect, it } from "vitest";
import {
  appliedBadge,
  appliedText,
  coefficientsOf,
  experimentName,
  featuresOf,
  gainOf,
  metricLabel,
  rateText,
  structureOf,
} from "../src/lib/experiments";
import type { ExperimentResult } from "../src/types/interfaces";

const metrics = (gain: ExperimentResult["metrics"]["gain"]): ExperimentResult["metrics"] => ({
  valid: { rows: 10, positives: 2, roc_auc: 0.8, pr_auc: 0.4 },
  test: { rows: 10, positives: 2, roc_auc: 0.8, pr_auc: 0.4 },
  gain,
  thresholds: { review: 0.5, block: 0.9 },
  at_review: { flagged: 3, precision: 0.5, recall: 0.75 },
  at_block: { flagged: 1, precision: 1, recall: 0.25 },
});

describe("experiment formatting", () => {
  it("describes the structure of each kind of model", () => {
    expect(structureOf({ type: "gbdt", features: ["a", "b", "c"] })).toBe("Trees · 3 fields");
    expect(structureOf({ type: "gbdt", features: ["a"] })).toBe("Trees · 1 field");
    expect(structureOf({ type: "logistic", features: ["a", "b"] })).toBe("Logistic · 2 fields");
    expect(
      structureOf({ type: "stacked", base: { type: "gbdt", features: ["a", "b", "c"] }, features: ["x", "y"] }),
    ).toBe("Trees on 3 fields → stacked with 2");
    expect(structureOf({ type: "stacked", base: { type: "gbdt", features: ["a"] }, features: [] })).toBe(
      "Trees on 1 field → logistic",
    );
    expect(structureOf({ type: "probability", feature: "hardship" })).toBe("Probability · hardship");
  });

  it("notes the transforms of the features", () => {
    expect(
      featuresOf({
        type: "stacked",
        base: { type: "gbdt", features: ["amount"] },
        features: ["hardship", "dti"],
        transforms: { hardship: "logit", dti: "identity" },
      }),
    ).toEqual({ trees: ["amount"], layer: ["hardship (logit)", "dti"] });
    expect(coefficientsOf({ coefficients: { base: 1.02, hardship: 0.31, bad: "x" } })).toEqual([
      ["base", 1.02],
      ["hardship", 0.31],
    ]);
    expect(coefficientsOf({ trees: 40 })).toEqual([]);
  });

  it("writes the gain with its interval, and marks the baseline", () => {
    const gain = { vs: "base", roc_auc: 0.0312, ci95: [0.012, 0.05] as [number, number] };
    expect(gainOf({ key: "x", metrics: metrics(gain) }, "base")).toEqual({
      text: "+0.031 [+0.012, +0.050]",
      better: true,
      baseline: false,
    });
    const unsure = { vs: "base", roc_auc: 0.01, ci95: [-0.004, null] as [number, null] };
    expect(gainOf({ key: "x", metrics: metrics(unsure) }, "base")).toMatchObject({
      text: "+0.010 [-0.004, —]",
      better: false,
    });
    expect(gainOf({ key: "base", metrics: metrics(null) }, "base").text).toBe("Baseline");
    expect(gainOf({ key: "x", metrics: metrics(null) }, "base").text).toBe("—");
  });

  it("writes rates, metrics, names and what was applied", () => {
    expect(rateText(0.5, null)).toBe("0.500 / —");
    expect(metricLabel("roc_auc")).toBe("ROC-AUC");
    expect(metricLabel("pr_auc")).toBe("PR-AUC");
    expect(appliedText(null)).toBe("Not applied");
    expect(appliedText({ variant: "x", version: 3, published: true, at: "" })).toBe("Published v3");
    expect(appliedText({ variant: "x", version: null, published: false, at: "" })).toBe("Draft");
    expect(appliedBadge({ variant: "x", version: 3, published: true, at: "" })).toBe("Applied v3");
    expect(appliedBadge({ variant: "x", version: null, published: false, at: "" })).toBe("Applied as draft");
    const config = { labels: ["bad"], window: "30d", features: {}, variants: [] } as never;
    expect(experimentName({ config: { ...(config as object), name: "Words" } as never, created_at: "" })).toBe("Words");
    expect(experimentName({ config, created_at: "2026-10-03T12:00:00Z" })).toBe("Experiment 3 Oct 2026");
  });
});
