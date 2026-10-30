import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import type { EnvironmentRow } from "../src/db/schema";
import { ApiKeysService } from "../src/services/api_key.service";
import { EnvironmentsService } from "../src/services/environment.service";
import { SessionsService } from "../src/services/session.service";
import { UsersService } from "../src/services/user.service";
import type { Environment } from "../src/types";
import { testDatabase } from "./helpers/database";

const NOW = new Date("2026-10-29T12:00:00Z");
const database = await testDatabase();
const accounts = tenancyRepository(database.db);
const environmentRepo = environmentsRepository(database.db);
let app: ReturnType<typeof createApp>;
let workspace: string;
let owner: string;
let cookie: string;
let production: EnvironmentRow;
let sandbox: Environment;
let sandboxKey: string;

/** Made by packages/core/test/fixtures/xgboost/make_fixtures.py. */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/core/test/fixtures/xgboost/${name}.json`, import.meta.url), "utf8"),
  ) as { model: Record<string, unknown>; samples: { features: Record<string, number | null>; score: number }[] };
const v3 = fixture("binary-3.0.2");
const v2 = fixture("binary-2.1.4");
const uploadOf = (from: typeof v3, name = "Loan default") => ({
  name,
  format: "xgboost-json",
  model: from.model,
  samples: from.samples.slice(0, 200),
});

const call = async (
  method: string,
  path: string,
  body?: unknown,
  scope: { environment?: string; key?: string } = {},
) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Kairos-Workspace": workspace,
      ...(scope.key ? { Authorization: `Bearer ${scope.key}` } : { Cookie: cookie }),
      ...(scope.environment ? { "X-Kairos-Environment": scope.environment } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : text) as any };
};
const inProduction = (method: string, path: string, body?: unknown) =>
  call(method, path, body, { environment: production.id });
const inSandbox = (method: string, path: string, body?: unknown) =>
  call(method, path, body, { environment: sandbox.id });
const newSandbox = (name: string, copy?: unknown) =>
  call("POST", `/app/workspaces/${workspace}/environments`, {
    name,
    copy_from: production.id,
    ...(copy ? { copy } : {}),
  });
const firstFeatures = v3.samples[0]!.features;

beforeEach(async () => {
  await database.reset();
  const user = await new UsersService(database.db).createWithAuth(
    {
      email: "owner@example.com",
      displayName: "Owner",
      auth: { provider: "native", strategy: "email_password" },
      passwordHash: "x",
    },
    NOW,
  );
  owner = user.id;
  workspace = (await accounts.createWorkspace("Acme", owner, NOW)).id;
  production = (await new EnvironmentsService(database.db, { workspaceId: workspace }).findByIdOrProduction())!;
  sandbox = (await environmentRepo.createSandbox(workspace, { name: "Development" }, owner, NOW))!;
  cookie = `kairos_session=${(await new SessionsService(database.db).start(owner, NOW)).token}`;
  sandboxKey = (
    await new ApiKeysService(database.db, { workspaceId: workspace }).createWithSecret(
      {
        environmentId: sandbox.id,
        name: "Development",
        kind: "secret",
        allowedIps: [],
        allowedOrigins: [],
        createdBy: owner,
      },
      NOW,
    )
  ).secret;
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentRepo,
    accounts,
    decider: async () => {
      throw new Error("no model call in these tests");
    },
    now: () => NOW,
  });
});

describe("the environment copy", () => {
  beforeEach(async () => {
    expect((await inProduction("POST", "/v1/models/loan-default/versions", uploadOf(v3))).status).toBe(201);
    expect((await inProduction("POST", "/v1/models/loan-default/versions", uploadOf(v2))).status).toBe(201);
    expect((await inProduction("POST", "/v1/models/old-model/versions", uploadOf(v3, "Old model"))).status).toBe(201);
    expect((await inProduction("POST", "/v1/models/old-model/archive")).status).toBe(200);
  });
  const slugsIn = async (environment: string) =>
    ((await call("GET", "/v1/models?kind=scoring", undefined, { environment })).body.models as { slug: string }[]).map(
      (m) => m.slug,
    );

  it("does not copy models unless they are selected", async () => {
    const plain = await newSandbox("Plain");
    expect(plain.status).toBe(201);
    expect(await slugsIn(plain.body.id)).toEqual([]);
    const actionsOnly = await newSandbox("Actions only", { actions: true });
    expect(await slugsIn(actionsOnly.body.id)).toEqual([]);
  });

  it("copies the active models with every version, the same numbers and the same files", async () => {
    const copy = await newSandbox("With models", { models: true });
    expect(copy.status).toBe(201);
    const target = copy.body.id;
    expect(await slugsIn(target)).toEqual(["loan-default"]);

    const copied = await call("GET", "/v1/models/loan-default", undefined, { environment: target });
    expect(copied.body.name).toBe("Loan default");
    expect(copied.body.version).toBe(2);
    expect(copied.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    for (const version of [1, 2]) {
      const path = `/v1/models/loan-default/versions/${version}`;
      expect((await call("GET", `${path}/file`, undefined, { environment: target })).body).toEqual(
        (await inProduction("GET", `${path}/file`)).body,
      );
      expect((await call("POST", `${path}/score`, { features: firstFeatures }, { environment: target })).body).toEqual(
        (await inProduction("POST", `${path}/score`, { features: firstFeatures })).body,
      );
    }
  });

  it("copies only the selected models, and refuses an archived one", async () => {
    expect((await inProduction("POST", "/v1/models/claim-fraud/versions", uploadOf(v3, "Claim fraud"))).status).toBe(
      201,
    );
    const copy = await newSandbox("One model", { models: { ids: ["claim-fraud"] } });
    expect(copy.status).toBe(201);
    expect(await slugsIn(copy.body.id)).toEqual(["claim-fraud"]);

    const archived = await newSandbox("Archived", { models: { ids: ["old-model"] } });
    expect(archived.status).toBe(400);
    expect(archived.body.error.type).toBe("invalid_copy_selection");
  });

  it("offers only the active models to copy", async () => {
    const options = await call(
      "GET",
      `/app/workspaces/${workspace}/environments/${production.id}/copy-options?category=models`,
    );
    expect(options.status).toBe(200);
    expect(options.body).toEqual({
      items: [{ id: "loan-default", label: "Loan default", detail: "loan-default · Version 2", type: null }],
      total: 1,
    });
  });
});

describe("a promotion", () => {
  beforeEach(async () => {
    expect((await inSandbox("POST", "/v1/models/loan-default/versions", uploadOf(v2))).status).toBe(201);
    expect((await inSandbox("POST", "/v1/models/loan-default/versions", uploadOf(v3))).status).toBe(201);
  });
  const promote = (version: number, to: string) =>
    inSandbox("POST", `/v1/models/loan-default/versions/${version}/promote`, { to });

  it("uploads the version in the target, and records where it came from", async () => {
    const promoted = await promote(2, production.id);
    expect(promoted.status).toBe(201);
    expect(promoted.body).toMatchObject({
      environment: production.id,
      reference: "loan-default@1",
      version: 1,
      created: true,
    });

    const sandboxVersion = (await inSandbox("GET", "/v1/models/loan-default/versions/2")).body.definition;
    const model = await inProduction("GET", "/v1/models/loan-default");
    expect(model.body.name).toBe("Loan default");
    expect(model.body.versions).toEqual([{ version: 1, created: NOW.toISOString(), created_by: owner }]);
    const { promoted_from, ...definition } = model.body.definition;
    expect(promoted_from).toEqual({
      environment: sandbox.id,
      version: 2,
      sha256: sandboxVersion.artifact.replace("sha256:", ""),
    });
    expect(definition).toEqual(sandboxVersion);
    expect(
      (await inProduction("POST", "/v1/models/loan-default/versions/1/score", { features: firstFeatures })).body.score,
    ).toBe(
      (await inSandbox("POST", "/v1/models/loan-default/versions/2/score", { features: firstFeatures })).body.score,
    );
  });

  it("makes no new version when the same version is promoted again, and a new one for another version", async () => {
    await promote(2, production.id);
    const again = await promote(2, production.id);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reference: "loan-default@1", created: false });
    expect((await promote(1, production.id)).body).toMatchObject({ reference: "loan-default@2", created: true });
  });

  it("keeps the name that the model has in the target", async () => {
    await inProduction("POST", "/v1/models/loan-default/versions", uploadOf(v2, "Production name"));
    expect((await promote(2, production.id)).body.reference).toBe("loan-default@2");
    expect((await inProduction("GET", "/v1/models/loan-default")).body.name).toBe("Production name");
  });

  it("refuses an API key, the same environment, an unknown environment and an archived model", async () => {
    const withKey = await call(
      "POST",
      "/v1/models/loan-default/versions/2/promote",
      { to: production.id },
      { key: sandboxKey },
    );
    expect(withKey.status).toBe(403);
    expect((await promote(2, sandbox.id)).status).toBe(400);
    expect((await promote(2, "env_unknown")).status).toBe(404);
    expect((await promote(9, production.id)).status).toBe(404);
    expect((await inSandbox("POST", "/v1/models/grayson-1/versions/1/promote", { to: production.id })).status).toBe(
      409,
    );

    await inProduction("POST", "/v1/models/loan-default/versions", uploadOf(v2));
    await inProduction("POST", "/v1/models/loan-default/archive");
    expect((await promote(2, production.id)).status).toBe(409);
  });

  it("cannot reach an environment of another workspace", async () => {
    const other = await accounts.createWorkspace("Other", owner, NOW);
    const foreign = (await new EnvironmentsService(database.db, { workspaceId: other.id }).findByIdOrProduction())!;
    expect((await promote(2, foreign.id)).status).toBe(404);
    const there = await app.request("/v1/models?kind=scoring", {
      headers: { Cookie: cookie, "X-Kairos-Workspace": other.id, "X-Kairos-Environment": foreign.id },
    });
    expect(((await there.json()) as { models: unknown[] }).models).toEqual([]);
  });
});
