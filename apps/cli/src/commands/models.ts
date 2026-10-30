import { CliError, integer, json, object, parse, props } from "../args";
import type { Client } from "../client";
import { group, need, path } from "../context";
import { bold, dim, fields, green, more, printJson, show, state, table } from "../output";

interface Model {
  slug: string;
  name: string;
  kind: string;
  runtime: string;
  status: string;
  version?: number;
  definition?: { features: unknown[]; metrics?: { test?: { roc_auc?: number } } };
}

const REF = "<slug>[@version]";

function reference(value: string | undefined, usage: string): { slug: string; version?: number } {
  const match = /^([^@]+)(?:@([1-9]\d*))?$/.exec(need(value, usage));
  if (!match) throw new CliError(`"${value}" is not a model: give <slug> or <slug>@<version>, such as loan-default@2`);
  return { slug: match[1]!, version: match[2] === undefined ? undefined : Number(match[2]) };
}

async function latest(client: Client, slug: string, version: number | undefined): Promise<number> {
  if (version) return version;
  const model: Model = await client.request("GET", `/v1/models/${path(slug)}`);
  if (!model.version) throw new CliError(`"${slug}" is a built-in model: it has no versions`);
  return model.version;
}

function uploadBody(values: { upload?: string; file?: string; samples?: string; name?: string; description?: string }) {
  if (values.upload && (values.file || values.samples))
    throw new CliError("Give --upload upload.json, or --file model.json with --samples samples.json, not both");
  const body = values.upload
    ? object(`@${values.upload}`, "--upload")
    : values.file && values.samples
      ? {
          format: "xgboost-json",
          model: json(`@${values.file}`, "--file"),
          samples: json(`@${values.samples}`, "--samples"),
        }
      : null;
  if (!body) throw new CliError("Give --upload upload.json, or --file model.json with --samples samples.json");
  return {
    ...body,
    ...(values.name ? { name: values.name } : {}),
    ...(values.description ? { description: values.description } : {}),
  };
}

export const models = group("models", {
  list: async (args, ctx) => {
    const { values } = parse(args, {
      kind: { type: "string" },
      q: { type: "string" },
      limit: { type: "string", short: "n" },
      offset: { type: "string" },
    });
    const data = await ctx.client().request("GET", "/v1/models", {
      query: {
        kind: values.kind,
        q: values.q,
        limit: integer(values.limit, "--limit"),
        offset: integer(values.offset, "--offset"),
      },
    });
    show(ctx.json, data, () => {
      table(data.models as Model[], [
        ["SLUG", (m) => m.slug],
        ["NAME", (m) => m.name],
        ["KIND", (m) => m.kind],
        ["RUNS IN", (m) => (m.runtime === "builtin" ? "built in" : "XGBoost")],
        ["VERSION", (m) => m.version],
        ["FEATURES", (m) => m.definition?.features.length],
        ["TEST ROC-AUC", (m) => m.definition?.metrics?.test?.roc_auc?.toFixed(3)],
        ["STATUS", (m) => state(m.status)],
      ]);
      more(data.total, data.models.length);
    });
  },
  get: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const { slug, version } = reference(positionals[0], `models get ${REF}`);
    printJson(await ctx.client().request("GET", `/v1/models/${path(slug)}${version ? `/versions/${version}` : ""}`));
  },
  upload: async (args, ctx) => {
    const { values, positionals } = parse(args, {
      upload: { type: "string" },
      file: { type: "string" },
      samples: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
    });
    const slug = need(
      positionals[0],
      'models upload <slug> (--upload upload.json | --file model.json --samples samples.json) [--name "Loan default"]',
    );
    const saved = await ctx
      .client()
      .request("POST", `/v1/models/${path(slug)}/versions`, { body: uploadBody(values), gzip: true });
    show(ctx.json, saved, () =>
      console.log(
        saved.created
          ? `${green("Uploaded")} ${bold(`${slug}@${saved.version}`)} ${dim(`loaded in ${saved.load_ms} ms`)}`
          : `The same as ${bold(`${slug}@${saved.version}`)}: no new version`,
      ),
    );
  },
  score: async (args, ctx) => {
    const { values, positionals } = parse(args, {
      feature: { type: "string", short: "f", multiple: true },
      data: { type: "string", short: "d" },
    });
    const { slug, version } = reference(positionals[0], `models score ${REF} -f name=value …`);
    const client = ctx.client();
    const at = await latest(client, slug, version);
    const result = await client.request("POST", `/v1/models/${path(slug)}/versions/${at}/score`, {
      body: { features: { ...object(values.data), ...props(values.feature) } },
    });
    show(ctx.json, result, () => {
      console.log(`${bold(result.score.toFixed(4))}  ${result.model}`);
      fields([
        ["risk score", result.risk_score],
        ["missing", result.missing.length ? result.missing.join(", ") : undefined],
        ["not numbers", result.invalid.length ? result.invalid.join(", ") : undefined],
      ]);
    });
  },
  promote: async (args, ctx) => {
    const { values, positionals } = parse(args, { to: { type: "string" } });
    const { slug, version } = reference(positionals[0], `models promote ${REF} --to <environment>`);
    if (!values.to) throw new CliError(`Usage: kairos models promote ${REF} --to <environment>`);
    const client = ctx.client();
    if (!client.hasSession)
      throw new CliError(`An API key is for one environment. Sign in with your email address: "kairos login --email".`);
    const me = await client.request("GET", "/auth/me");
    const environments: { id: string; name: string }[] =
      me.workspaces.find((w: { id: string }) => w.id === client.conn.workspace)?.environments ?? [];
    const wanted = values.to.toLowerCase();
    const target =
      environments.find((e) => e.id === values.to) ?? environments.find((e) => e.name.toLowerCase() === wanted);
    if (!target)
      throw new CliError(`No environment "${values.to}". There is: ${environments.map((e) => e.name).join(", ")}`);
    const at = await latest(client, slug, version);
    const promoted = await client.request("POST", `/v1/models/${path(slug)}/versions/${at}/promote`, {
      body: { to: target.id },
    });
    show(ctx.json, promoted, () =>
      console.log(
        promoted.created
          ? `${green("Promoted")} ${slug}@${at} to ${bold(target.name)} as ${bold(promoted.reference)}`
          : `${target.name} has it already as ${bold(promoted.reference)}: no new version`,
      ),
    );
  },
});
