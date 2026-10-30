import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ModelCache } from "../src/modules/models/libs";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const T1 = new Date("2026-10-06T14:00:00Z");
const T2 = new Date("2026-10-06T15:00:00Z");
let clock = T1;
const database = await testDatabase();
let app: ReturnType<typeof createApp>;

/** Made by packages/core/test/fixtures/xgboost/make_fixtures.py. */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/core/test/fixtures/xgboost/${name}.json`, import.meta.url), "utf8"),
  ) as {
    model: Record<string, any>;
    samples: { features: Record<string, number | null>; score: number }[];
  };
const v3 = fixture("binary-3.0.2");
const v2 = fixture("binary-2.1.4");

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
  clock = T1;
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => {
      throw new Error("no model call in these tests");
    },
    now: () => clock,
  });
});

const call = (method: string, path: string, body?: unknown, key = "key_a") =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const upload = (slug: string, body: unknown, options: { gzip?: boolean; key?: string; raw?: Uint8Array } = {}) =>
  app.request(`/v1/models/${slug}/versions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.key ?? "key_a"}`,
      "Content-Type": "application/json",
      ...(options.gzip || options.raw ? { "Content-Encoding": "gzip" } : {}),
    },
    body: (options.raw ?? (options.gzip ? gzipSync(JSON.stringify(body)) : JSON.stringify(body))) as BodyInit,
  });

const loanDefault = (from = v3, extra: Record<string, unknown> = {}) => ({
  name: "Loan default",
  format: "xgboost-json",
  model: from.model,
  samples: from.samples.slice(0, 200),
  ...extra,
});

const count = async (table: string) =>
  (await database.db.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0]!.n;

describe("the list of models", () => {
  it("has the built-in Grayson model in every environment", async () => {
    const grayson = { slug: "grayson-1", name: "Grayson 1", kind: "question", runtime: "builtin", status: "active" };
    expect(await (await call("GET", "/v1/models")).json()).toEqual({ models: [grayson], total: 1 });
    expect(await (await call("GET", "/v1/models/grayson-1")).json()).toEqual(grayson);
  });

  it("searches the slug and the name, and gives one page with the total", async () => {
    await upload("loan-default", loanDefault());
    await upload("claim-fraud", loanDefault(v3, { name: "Claim fraud" }));
    await upload("card-takeover", loanDefault(v3, { name: "Card takeover" }));
    const list = async (query: string) => {
      const body = await (await call("GET", `/v1/models?${query}`)).json();
      return { slugs: (body.models as { slug: string }[]).map((m) => m.slug), total: body.total };
    };
    expect(await list("")).toEqual({
      slugs: ["grayson-1", "card-takeover", "claim-fraud", "loan-default"],
      total: 4,
    });
    expect(await list("q=CLAIM")).toEqual({ slugs: ["claim-fraud"], total: 1 });
    expect(await list("q=card")).toEqual({ slugs: ["card-takeover"], total: 1 });
    expect(await list("q=grayson")).toEqual({ slugs: ["grayson-1"], total: 1 });
    expect(await list("q=nothing")).toEqual({ slugs: [], total: 0 });
    expect(await list("limit=2")).toEqual({ slugs: ["grayson-1", "card-takeover"], total: 4 });
    expect(await list("limit=2&offset=2")).toEqual({ slugs: ["claim-fraud", "loan-default"], total: 4 });
    expect(await list("limit=1&offset=1&kind=scoring")).toEqual({ slugs: ["claim-fraud"], total: 3 });
    expect((await call("GET", "/v1/models?limit=501")).status).toBe(400);
  });

  it("filters by kind", async () => {
    await upload("loan-default", loanDefault());
    const slugs = async (kind: string) =>
      ((await (await call("GET", `/v1/models?kind=${kind}`)).json()).models as { slug: string }[]).map((m) => m.slug);
    expect(await slugs("question")).toEqual(["grayson-1"]);
    expect(await slugs("scoring")).toEqual(["loan-default"]);
    expect((await call("GET", "/v1/models?kind=other")).status).toBe(400);
  });
});

describe("an upload", () => {
  it("makes the model and its first version, with gzip or without", async () => {
    const response = await upload("loan-default", loanDefault(v3, { description: "Default risk" }), { gzip: true });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ version: 1, created: true, model: { slug: "loan-default", name: "Loan default" } });
    expect(body.load_ms).toBeGreaterThanOrEqual(0);
    expect(body.model.definition).toMatchObject({
      kind: "scoring",
      format: "xgboost-json",
      objective: "binary:logistic",
      features: ["hardship", "income_plausible", "grayson_hold", "amount", "dti", "country_gb"].map((name) => ({
        name,
        type: "float",
      })),
      trees: 33,
      depth: 4,
      parity: { samples: 200 },
      description: "Default risk",
    });
    expect(body.model.definition.artifact).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.model.definition.parity.max_difference).toBeLessThan(2e-7);

    expect((await upload("other", loanDefault())).status).toBe(201);
    expect(await count("model_artifacts")).toBe(1);
  });

  it("makes no version when nothing changed", async () => {
    await upload("loan-default", loanDefault());
    const again = await upload("loan-default", loanDefault());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ version: 1, created: false });
    expect(await count("definition_versions")).toBe(1);
  });

  it("adds a version, and keeps the old one", async () => {
    await upload("loan-default", loanDefault(v3));
    clock = T2;
    const second = await upload("loan-default", { ...loanDefault(v2), name: "Loan default risk" });
    expect(await second.json()).toMatchObject({ version: 2, created: true, model: { name: "Loan default risk" } });

    const model = await (await call("GET", "/v1/models/loan-default")).json();
    expect(model).toMatchObject({ version: 2, status: "active", created: T1.toISOString(), updated: T2.toISOString() });
    expect(model.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const first = await (await call("GET", "/v1/models/loan-default/versions/1")).json();
    expect(first.definition.trees).toBe(33);
    expect(await count("model_artifacts")).toBe(2);
  });

  it("needs a name for the first version only", async () => {
    const { name: _, ...nameless } = loanDefault();
    const refused = await upload("loan-default", nameless);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toBe("name: needed for the first version of a model");
    await upload("loan-default", loanDefault(v3));
    expect(
      (await upload("loan-default", { ...nameless, model: v2.model, samples: v2.samples.slice(0, 200) })).status,
    ).toBe(201);
  });

  it("refuses a slug that is not a slug, and a built-in slug", async () => {
    const bad = await upload("Loan_Default", loanDefault());
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain('slug: "Loan_Default" must be lowercase letters and digits');
    const builtin = await upload("grayson-1", loanDefault());
    expect(builtin.status).toBe(409);
    expect((await builtin.json()).error.message).toBe('"grayson-1" is a built-in model: it cannot be uploaded');
  });

  it("refuses a model that Kairos cannot score", async () => {
    const response = await upload("multi", loanDefault({ ...v3, model: fixture("refuse-multiclass").model }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(
      'model: the objective is "multi:softprob"; only binary:logistic is accepted; model: the model has more than one output; only one is accepted',
    );
    expect(await count("models")).toBe(0);
  });

  it("refuses a model whose scores differ from XGBoost's, and names the samples", async () => {
    const samples = v3.samples.slice(0, 200).map((s, n) => (n === 7 ? { ...s, score: s.score + 0.05 } : s));
    const response = await upload("loan-default", { ...loanDefault(), samples });
    expect(response.status).toBe(400);
    const message = (await response.json()).error.message as string;
    expect(message).toMatch(
      /^samples: Kairos and XGBoost give different scores, so the model is refused: samples\[7\]/,
    );
    expect(await count("model_artifacts")).toBe(0);
  });

  it("refuses samples that do not fit the model", async () => {
    const response = await upload("loan-default", { ...loanDefault(), samples: v3.samples.slice(0, 50) });
    expect((await response.json()).error.message).toBe("samples must be a list of 100 to 1000 rows");
  });

  it("refuses suggested features that the model does not have", async () => {
    const response = await upload(
      "loan-default",
      loanDefault(v3, { suggested_features: { hardship: "{{ steps.ask.output.hardship.probability }}", age: "1" } }),
    );
    expect((await response.json()).error.message).toBe("suggested_features: the model has no feature age");
  });

  it("refuses a body that is too large, before and after gzip", async () => {
    const large = await upload("loan-default", null, { raw: new Uint8Array(4 * 1024 * 1024 + 1) });
    expect(large.status).toBe(413);
    // 65 MB of spaces is about 64 KB with gzip.
    const bomb = await upload("loan-default", null, { raw: gzipSync(Buffer.alloc(65 * 1024 * 1024, " ")) });
    expect(bomb.status).toBe(413);
    expect((await bomb.json()).error.message).toBe("The body is larger than 64 MB without gzip");
    const notGzip = await upload("loan-default", null, { raw: new TextEncoder().encode("{}") });
    expect(notGzip.status).toBe(400);
  });
});

describe("a stored model", () => {
  beforeEach(async () => {
    expect((await upload("loan-default", loanDefault())).status).toBe(201);
  });

  it("gives back its file, which is the same model", async () => {
    const response = await call("GET", "/v1/models/loan-default/versions/1/file");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="loan-default-1.json"');
    expect(await response.json()).toEqual(v3.model);
    expect((await call("GET", "/v1/models/loan-default/versions/2/file")).status).toBe(404);
  });

  it("scores a row as XGBoost does", async () => {
    for (const sample of v3.samples.slice(300, 320)) {
      const response = await call("POST", "/v1/models/loan-default/versions/1/score", { features: sample.features });
      const body = await response.json();
      expect(Math.abs(body.score - sample.score)).toBeLessThan(1e-6);
      expect(body.risk_score).toBe(Math.round(body.score * 100));
      expect(body.model).toBe("loan-default@1");
    }
  });

  it("scores missing, boolean and text values, and says which were missing", async () => {
    const response = await call("POST", "/v1/models/loan-default/versions/1/score", {
      features: { hardship: "0.8", income_plausible: true, grayson_hold: null, dti: "high", country_gb: 1 },
    });
    const body = await response.json();
    expect(body.features).toEqual({
      hardship: 0.8,
      income_plausible: 1,
      grayson_hold: null,
      amount: null,
      dti: null,
      country_gb: 1,
    });
    expect(body.missing).toEqual(["grayson_hold", "amount", "dti"]);
    expect(body.invalid).toEqual(["dti"]);
    expect(body.score).toBeGreaterThan(0);
    expect(body.score).toBeLessThan(1);
  });

  it("refuses a feature that the model does not have", async () => {
    const response = await call("POST", "/v1/models/loan-default/versions/1/score", { features: { age: 40 } });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("features: the model has no feature age");
  });

  it("changes its name, and the slug stays", async () => {
    clock = T2;
    const renamed = await (await call("PATCH", "/v1/models/loan-default", { name: "Personal loans" })).json();
    expect(renamed).toMatchObject({ slug: "loan-default", name: "Personal loans", version: 1 });
    expect((await call("PATCH", "/v1/models/grayson-1", { name: "G" })).status).toBe(409);
    expect((await call("PATCH", "/v1/models/nothing", { name: "G" })).status).toBe(404);
  });

  it("is archived: it takes no new version, and it still scores", async () => {
    clock = T2;
    const archived = await (await call("POST", "/v1/models/loan-default/archive")).json();
    expect(archived).toMatchObject({ status: "archived", archived_at: T2.toISOString() });
    const refused = await upload("loan-default", loanDefault(v2));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toBe('The model "loan-default" is archived');
    const sample = v3.samples[0]!;
    expect((await call("POST", "/v1/models/loan-default/versions/1/score", { features: sample.features })).status).toBe(
      200,
    );
  });

  it("is not seen from another workspace", async () => {
    expect((await call("GET", "/v1/models/loan-default", undefined, "key_b")).status).toBe(404);
    expect((await call("POST", "/v1/models/loan-default/versions/1/score", { features: {} }, "key_b")).status).toBe(
      404,
    );
    const models = (await (await call("GET", "/v1/models", undefined, "key_b")).json()).models;
    expect(models.map((m: { slug: string }) => m.slug)).toEqual(["grayson-1"]);
  });

  it("refuses a version that is not a version", async () => {
    expect((await call("GET", "/v1/models/loan-default/versions/0")).status).toBe(400);
    expect((await call("GET", "/v1/models/loan-default/versions/9")).status).toBe(404);
    expect((await call("GET", "/v1/models/grayson-1/versions/1")).status).toBe(404);
  });
});

describe("the model cache", () => {
  const model = (nodes: number) => ({ features: [], trees: 1, nodes, depth: 1, score: () => 0.5 });

  it("loads a file once, also when two loads start together", async () => {
    const cache = new ModelCache();
    let loads = 0;
    const load = async () => {
      loads++;
      return model(10);
    };
    const [a, b] = await Promise.all([cache.get("x", load), cache.get("x", load)]);
    expect(a).toBe(b);
    await cache.get("x", load);
    expect(loads).toBe(1);
  });

  it("removes the model used least recently when it is full", async () => {
    // 100 nodes are 1,700 bytes: two fit in 3,500.
    const cache = new ModelCache(3500);
    const loaded: string[] = [];
    const load = (key: string) => async () => (loaded.push(key), model(100));
    await cache.get("a", load("a"));
    await cache.get("b", load("b"));
    await cache.get("a", load("a"));
    await cache.get("c", load("c"));
    expect(cache.size).toBe(2);
    await cache.get("a", load("a"));
    await cache.get("b", load("b"));
    expect(loaded).toEqual(["a", "b", "c", "b"]);
  });
});
