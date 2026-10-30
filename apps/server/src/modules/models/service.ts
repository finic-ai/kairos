import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  checkParity,
  featureValues,
  loadLogistic,
  loadXgboost,
  type ModelVersionDefinition,
  type XgboostModel,
} from "@kairos/core";
import type { Executor } from "../../platform/database";
import { AppError, invalid, notFound } from "../../platform/error";
import { saveVersion } from "../../services/definition_version.service";
import { EnvironmentsService } from "../../services/environment.service";
import { ModelArtifactsService } from "../../services/model_artifact.service";
import { ModelsService, type ModelView } from "../../services/model.service";
import { WorkflowsService } from "../../services/workflow.service";
import { modelCache } from "./libs";
import type { ListQuery, UploadBody } from "./schema";
import type { BuiltinModel, ScoreResult, Scorer } from "./types";

type Scope = { workspaceId: string; environmentId: string };

export const BUILTIN_MODELS: readonly BuiltinModel[] = [
  { slug: "grayson-1", name: "Grayson 1", kind: "question", runtime: "builtin", status: "active" },
];

export const MODEL_SLUG = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;
const REF = /^([^@]+)(?:@([1-9]\d*))?$/;
const MAX_NOTES_BYTES = 16 * 1024;

const builtin = (slug: string) => BUILTIN_MODELS.find((m) => m.slug === slug);
const conflict = (message: string) => new AppError("conflict", "conflict", message);

export function parseModelRef(ref: string): { slug: string; version?: number } | null {
  const match = REF.exec(ref);
  if (!match || !MODEL_SLUG.test(match[1]!)) return null;
  return match[2] === undefined ? { slug: match[1]! } : { slug: match[1]!, version: Number(match[2]) };
}

export async function listModels(db: Executor, scope: Scope, { kind, q, limit, offset }: ListQuery) {
  const needle = q.toLowerCase();
  const builtins =
    kind === "scoring" ? [] : BUILTIN_MODELS.filter((m) => `${m.slug} ${m.name}`.toLowerCase().includes(needle));
  const shown = builtins.slice(offset, offset + limit);
  const uploaded =
    kind === "question"
      ? { models: [], total: 0 }
      : await new ModelsService(db, scope).list(q, limit - shown.length, Math.max(0, offset - builtins.length));
  return { models: [...shown, ...uploaded.models], total: builtins.length + uploaded.total };
}

export async function getModel(db: Executor, scope: Scope, slug: string) {
  const found = builtin(slug);
  if (found) return found;
  const models = new ModelsService(db, scope);
  const model = await models.findBySlug(slug);
  if (!model) throw notFound(`No model "${slug}"`);
  return { ...model, versions: await models.listVersions(slug) };
}

export async function getVersion(db: Executor, scope: Scope, slug: string, version: number) {
  const definition = await findDefinition(db, scope, slug, version);
  return { slug, version, definition };
}

export async function readModelFile(db: Executor, scope: Scope, slug: string, version: number): Promise<Buffer> {
  const definition = await findDefinition(db, scope, slug, version);
  const file = await new ModelArtifactsService(db, scope).findFile(sha256Of(definition));
  if (!file) throw notFound(`The file of ${slug}@${version} is not stored`);
  return gunzipSync(file);
}

export interface UploadResult {
  model: ModelView;
  version: number;
  /** False when the upload was the same as the latest version, and no version was made. */
  created: boolean;
  load_ms: number;
}

export async function uploadVersion(
  db: Executor,
  scope: Scope,
  slug: string,
  body: UploadBody,
  now: Date,
  by: string | null,
  promotedFrom?: ModelVersionDefinition["promoted_from"],
): Promise<UploadResult> {
  if (!MODEL_SLUG.test(slug))
    throw invalid(`slug: "${slug}" must be lowercase letters and digits, in groups joined by one "-"`);
  if (builtin(slug)) throw conflict(`"${slug}" is a built-in model: it cannot be uploaded`);

  const started = performance.now();
  const format = body.format ?? "xgboost-json";
  const loaded = loadFile(format, body.model);
  if (!loaded.model) throw invalid(loaded.problems.map((p) => `model: ${p}`).join("; "));
  const xgb = loaded.model;
  const parity = checkParity(xgb, body.samples);
  if (parity.problems.length) throw invalid(parity.problems.join("; "));
  if (parity.mismatches.length)
    throw invalid(
      `samples: Kairos and XGBoost give different scores, so the model is refused: ${parity.mismatches
        .map((m) => `samples[${m.sample}] ${m.expected} from XGBoost, ${m.actual} from Kairos`)
        .join("; ")}`,
    );
  const load_ms = Math.round(performance.now() - started);

  const unknown = Object.keys(body.suggested_features ?? {}).filter((name) => !xgb.features.includes(name));
  if (unknown.length) throw invalid(`suggested_features: the model has no feature ${unknown.join(", ")}`);
  for (const field of ["metrics", "training"] as const) {
    if (body[field] && Buffer.byteLength(JSON.stringify(body[field])) > MAX_NOTES_BYTES)
      throw invalid(`${field}: at most ${MAX_NOTES_BYTES / 1024} KB`);
  }

  const json = Buffer.from(JSON.stringify(body.model));
  const sha256 = createHash("sha256").update(json).digest("hex");
  const learner = body.model.learner as { feature_types?: unknown[] } | undefined;
  const types = Array.isArray(learner?.feature_types) ? learner.feature_types : [];
  const definition: ModelVersionDefinition = {
    kind: "scoring",
    format,
    objective: "binary:logistic",
    features: xgb.features.map((name, i) => ({ name, type: typeof types[i] === "string" ? types[i] : "float" })),
    trees: xgb.trees,
    depth: xgb.depth,
    artifact: `sha256:${sha256}`,
    parity: { samples: parity.samples, max_difference: parity.max_difference },
    ...(body.description ? { description: body.description } : {}),
    ...(body.metrics ? { metrics: body.metrics } : {}),
    ...(body.training ? { training: body.training } : {}),
    ...(body.suggested_features ? { suggested_features: body.suggested_features } : {}),
    ...(promotedFrom ? { promoted_from: promotedFrom } : {}),
  };

  return db.transaction(async (tx) => {
    const models = new ModelsService(tx, scope);
    const current = await models.findBySlug(slug);
    if (current?.status === "archived") throw conflict(`The model "${slug}" is archived`);
    if (!current && !body.name) throw invalid("name: needed for the first version of a model");

    await new ModelArtifactsService(tx, scope).store(
      {
        sha256,
        format,
        file: gzipSync(json),
        size: json.length,
        samples: gzipSync(JSON.stringify(body.samples)),
        sampleCount: parity.samples,
      },
      now,
    );
    const saved = await saveVersion(
      tx,
      scope,
      "model",
      slug,
      definition as unknown as Record<string, unknown>,
      by,
      now,
    );
    const name = body.name ?? current!.name;
    if (!current) await models.create({ slug, name, kind: "scoring", version: saved.version, definition }, now);
    else if (saved.changed || name !== current.name)
      await models.updateMany({ slug }, { name, version: saved.version, definition }, now);
    return { model: (await models.findBySlug(slug))!, version: saved.version, created: saved.changed, load_ms };
  });
}

export interface PromoteResult extends UploadResult {
  environment: string;
  reference: string;
}

export async function promoteVersion(
  db: Executor,
  scope: Scope,
  slug: string,
  version: number,
  to: string,
  now: Date,
  by: string,
): Promise<PromoteResult> {
  if (builtin(slug)) throw conflict(`"${slug}" is a built-in model: it is in every environment`);
  if (to === scope.environmentId) throw invalid("to: the version is already in this environment");
  const target = await new EnvironmentsService(db, { workspaceId: scope.workspaceId }).findByIdOrProduction(to);
  if (!target) throw notFound(`No environment "${to}" in this workspace`);
  const model = await new ModelsService(db, scope).findBySlug(slug);
  if (!model) throw notFound(`No model "${slug}"`);
  const definition = await findDefinition(db, scope, slug, version);
  const sha256 = sha256Of(definition);
  const artifacts = new ModelArtifactsService(db, scope);
  const [file, samples] = await Promise.all([artifacts.findFile(sha256), artifacts.findSamples(sha256)]);
  if (!file || !samples) throw notFound(`The file of ${slug}@${version} is not stored`);
  const targetScope = { workspaceId: scope.workspaceId, environmentId: target.id };
  const inTarget = await new ModelsService(db, targetScope).findBySlug(slug);
  const { description, metrics, training, suggested_features } = definition;
  const body: UploadBody = {
    ...(inTarget ? {} : { name: model.name }),
    format: definition.format,
    model: JSON.parse(gunzipSync(file).toString("utf8")),
    samples: JSON.parse(gunzipSync(samples).toString("utf8")),
    description,
    metrics,
    training,
    suggested_features,
  };
  const result = await uploadVersion(db, targetScope, slug, body, now, by, {
    environment: scope.environmentId,
    version,
    sha256,
  });
  return { ...result, environment: target.id, reference: `${slug}@${result.version}` };
}

export async function renameModel(db: Executor, scope: Scope, slug: string, name: string, now: Date) {
  if (builtin(slug)) throw conflict(`"${slug}" is a built-in model: it cannot be changed`);
  const models = new ModelsService(db, scope);
  const [changed] = await models.updateMany({ slug }, { name }, now);
  if (!changed) throw notFound(`No model "${slug}"`);
  return (await models.findBySlug(slug))!;
}

function scoresWith(steps: unknown, slug: string): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some(
    (step: Record<string, unknown> | null) =>
      !!step &&
      typeof step === "object" &&
      ((step.type === "score" && typeof step.model === "string" && step.model.split("@")[0] === slug) ||
        scoresWith(step.then, slug) ||
        scoresWith(step.else, slug) ||
        scoresWith(step.steps, slug)),
  );
}

export async function archiveModel(db: Executor, scope: Scope, slug: string, now: Date) {
  if (builtin(slug)) throw conflict(`"${slug}" is a built-in model: it cannot be archived`);
  const models = new ModelsService(db, scope);
  const current = await models.findBySlug(slug);
  if (!current) throw notFound(`No model "${slug}"`);
  const using = (await new WorkflowsService(db, scope).listAll())
    .filter((w) => w.status === "published" && scoresWith(w.steps, slug))
    .map((w) => `"${w.displayName ?? w.name}"`);
  if (using.length)
    throw conflict(
      `The model "${slug}" is used by the published workflow${using.length > 1 ? "s" : ""} ${using.join(", ")}: change or archive ${using.length > 1 ? "them" : "it"} first`,
    );
  if (current.status !== "archived") await models.updateMany({ slug }, { status: "archived", archivedAt: now }, now);
  return (await models.findBySlug(slug))!;
}

export async function describeModel(
  db: Executor,
  scope: Scope,
  ref: string,
): Promise<{ kind: "question" | "scoring"; features?: readonly string[] } | string> {
  const parsed = parseModelRef(ref);
  if (!parsed) return `"${ref}" is not a model slug, or a slug and a version`;
  const found = builtin(parsed.slug);
  if (found) return parsed.version ? `"${parsed.slug}" is a built-in model: it has no versions` : { kind: found.kind };
  const models = new ModelsService(db, scope);
  const model = await models.findBySlug(parsed.slug);
  if (!model) return `there is no model "${parsed.slug}"`;
  if (model.status === "archived") return `the model "${parsed.slug}" is archived`;
  const version = parsed.version ?? model.version;
  const definition = version === model.version ? model.definition : await models.findVersion(parsed.slug, version);
  if (!definition) return `there is no version ${version} of the model "${parsed.slug}"`;
  return { kind: "scoring", features: definition.features.map((f) => f.name) };
}

/** An archived model still scores, so that the workflows that already use it keep working. */
export async function loadScorer(db: Executor, scope: Scope, ref: string): Promise<Scorer> {
  const parsed = parseModelRef(ref);
  if (!parsed) throw invalid(`model: "${ref}" is not a model slug, or a slug and a version`);
  if (builtin(parsed.slug)) throw invalid(`model: "${parsed.slug}" is a question model; a score needs a scoring model`);
  const models = new ModelsService(db, scope);
  const model = await models.findBySlug(parsed.slug);
  if (!model) throw notFound(`No model "${parsed.slug}"`);
  const version = parsed.version ?? model.version;
  const definition =
    version === model.version ? model.definition : await findDefinition(db, scope, parsed.slug, version);
  const sha256 = sha256Of(definition);
  const xgb = await modelCache.get(sha256, async () => {
    const file = await new ModelArtifactsService(db, scope).findFile(sha256);
    if (!file) throw notFound(`The file of ${parsed.slug}@${version} is not stored`);
    const loaded = loadFile(definition.format, JSON.parse(gunzipSync(file).toString("utf8")));
    if (!loaded.model) throw new Error(`The stored file of ${parsed.slug}@${version} cannot be read`);
    return loaded.model;
  });
  return { ref: `${parsed.slug}@${version}`, features: xgb.features, score: (row) => xgb.score(row) };
}

export async function scoreFeatures(
  db: Executor,
  scope: Scope,
  ref: string,
  input: Record<string, unknown>,
  options: { strict?: boolean } = {},
): Promise<ScoreResult> {
  const scorer = await loadScorer(db, scope, ref);
  const values = featureValues(scorer.features, input);
  if (options.strict && values.unknown.length)
    throw invalid(`features: the model has no feature ${values.unknown.join(", ")}`);
  const score = scorer.score(values.row);
  return {
    score,
    risk_score: Math.round(score * 100),
    model: scorer.ref,
    features: values.values,
    missing: values.missing,
    invalid: values.invalid,
  };
}

async function findDefinition(db: Executor, scope: Scope, slug: string, version: number) {
  if (builtin(slug)) throw notFound(`"${slug}" is a built-in model: it has no versions to read`);
  const definition = await new ModelsService(db, scope).findVersion(slug, version);
  if (!definition) throw notFound(`No version ${version} of model "${slug}"`);
  return definition;
}

function loadFile(
  format: ModelVersionDefinition["format"],
  json: unknown,
): { model?: XgboostModel; problems: string[] } {
  return format === "logistic-json" ? loadLogistic(json) : loadXgboost(json);
}

const sha256Of = (definition: ModelVersionDefinition) => definition.artifact.replace(/^sha256:/, "");
