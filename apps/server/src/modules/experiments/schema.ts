import { z } from "zod";

const FEATURE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const VARIANT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const name = z.string().regex(FEATURE, "letters, digits and _, starting with a letter or _");
const names = z.array(name).min(1).max(200);
const transforms = z.record(z.enum(["identity", "logit"])).optional();

const gbdtParams = z
  .object({
    max_depth: z.number().int().min(1).max(10).optional(),
    eta: z.number().gt(0).max(1).optional(),
    rounds: z.number().int().min(1).max(2000).optional(),
    min_child_weight: z.number().min(0).optional(),
    lambda: z.number().min(0).optional(),
    gamma: z.number().min(0).optional(),
    subsample: z.number().gt(0).max(1).optional(),
    colsample: z.number().gt(0).max(1).optional(),
    bins: z.number().int().min(8).max(256).optional(),
    early_stopping_rounds: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const gbdt = z.object({ type: z.literal("gbdt"), features: names, params: gbdtParams.optional() }).strict();

export const variantModel = z.discriminatedUnion("type", [
  gbdt,
  z
    .object({
      type: z.literal("logistic"),
      features: names,
      transforms,
      l2: z.number().min(0).max(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("stacked"),
      base: gbdt,
      features: z.array(name).max(200).default([]),
      transforms,
      l2: z.number().min(0).max(100).optional(),
    })
    .strict(),
  z.object({ type: z.literal("probability"), feature: name }).strict(),
]);
export type VariantModel = z.infer<typeof variantModel>;

export const experimentVariant = z
  .object({
    key: z.string().max(40).regex(VARIANT, 'lowercase letters and digits, in groups joined by "-"'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).default(""),
    model: variantModel,
    /** Steps of the workflow this variant does not need, such as an ask step whose answers it does not read. */
    drop_steps: z.array(z.string().min(1).max(64)).max(50).default([]),
  })
  .strict();
export type ExperimentVariant = z.infer<typeof experimentVariant>;

export const experimentFields = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    hypothesis: z.string().trim().max(2000).optional(),
    labels: z.array(z.string().min(1).max(128)).min(1).max(20),
    window: z.string().regex(/^\d+(\.\d+)?(s|m|h|d)$/, 'a time such as "180d"'),
    subject: z
      .object({ type: z.string().min(1).max(64), id: z.string().min(1).max(2000) })
      .strict()
      .optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    /**
     * Replay the action's past requests through the workflow (its draft, else its live version)
     * before training, as test runs: the rows are those runs, not the workflow's live ones.
     */
    backtest: z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(100_000).optional(),
      })
      .strict()
      .optional(),
    /** Feature name → a template read over each run, as a score step reads it. */
    features: z
      .record(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
      .refine((f) => Object.keys(f).length <= 500, "at most 500 features")
      .refine((f) => Object.keys(f).every((k) => FEATURE.test(k)), "feature names are letters, digits and _")
      .default({}),
    variants: z.array(experimentVariant).max(12).default([]),
    split: z
      .object({ train: z.number().gt(0).lt(1), valid: z.number().gt(0).lt(1) })
      .strict()
      .refine((s) => s.train + s.valid < 1, "train and valid leave rows to test")
      .default({ train: 0.6, valid: 0.2 }),
    metric: z.enum(["roc_auc", "pr_auc"]).default("roc_auc"),
    baseline: z.string().optional(),
    review_rate: z.number().gt(0).lt(1).default(0.1),
    block_rate: z.number().gt(0).lt(1).default(0.02),
    /** The models' slugs start with it. Default: the workflow's name. */
    model_prefix: z.string().max(40).regex(VARIANT, 'lowercase letters and digits, in groups joined by "-"').optional(),
    /** Who asked for it, such as "mcp:Investigator", when it is not a signed-in person. */
    by: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const experimentBody = experimentFields.superRefine((body, ctx) => {
  // A backtest alone reports what the workflow would have decided; anything else compares variants.
  if (!body.backtest && body.variants.length === 0)
    ctx.addIssue({ code: "custom", path: ["variants"], message: "1 to 12 variants, or a backtest" });
  if (body.variants.length > 0 && Object.keys(body.features).length === 0)
    ctx.addIssue({ code: "custom", path: ["features"], message: "the features the variants read" });
  if (body.backtest?.from && body.backtest.to && body.backtest.from >= body.backtest.to)
    ctx.addIssue({ code: "custom", path: ["backtest", "to"], message: "after from" });
  const keys = body.variants.map((v) => v.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["variants"], message: "a key twice" });
  if (body.baseline !== undefined && !keys.includes(body.baseline))
    ctx.addIssue({ code: "custom", path: ["baseline"], message: `not a variant: ${body.baseline}` });
  if (body.block_rate > body.review_rate)
    ctx.addIssue({ code: "custom", path: ["block_rate"], message: "at most review_rate" });
  const known = new Set(Object.keys(body.features));
  body.variants.forEach((v, i) => {
    const used =
      v.model.type === "probability"
        ? [v.model.feature]
        : v.model.type === "stacked"
          ? [...v.model.base.features, ...v.model.features]
          : v.model.features;
    const missing = used.filter((f) => !known.has(f));
    if (missing.length)
      ctx.addIssue({
        code: "custom",
        path: ["variants", i, "model"],
        message: `not in features: ${[...new Set(missing)].join(", ")}`,
      });
    if (v.model.type === "stacked" && v.model.features.includes("base"))
      ctx.addIssue({ code: "custom", path: ["variants", i, "model", "features"], message: '"base" is the base score' });
  });
});
export type ExperimentBody = z.infer<typeof experimentBody>;

export const applyBody = z
  .object({
    variant: z.string().min(1),
    reason: z.string().trim().max(2000).optional(),
    publish: z.boolean().default(false),
    by: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const renameBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** Variant key → its new name. */
    variants: z.record(z.string().trim().min(1).max(80)).optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || Object.keys(b.variants ?? {}).length > 0, "a name or variants to rename");
export type RenameBody = z.infer<typeof renameBody>;
