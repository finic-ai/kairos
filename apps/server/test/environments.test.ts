import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { GraysonRequest } from "@kairos/core";
import { createApp } from "../src/app";
import { environments, memberships, webhookDeliveries } from "../src/db/schema";
import { secretBox } from "../src/platform/secrets";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { createAutomatic } from "../src/modules/decisions/libs";
import { ApiKeysService } from "../src/services/api_key.service";
import { createJobs } from "../src/platform/jobs/worker";
import type { Environment } from "../src/types";
import type { EnvironmentRow } from "../src/db/schema";
import { EnvironmentsService } from "../src/services/environment.service";
import { ActionsService } from "../src/services/action.service";
import { QueuesService } from "../src/services/queue.service";
import { DashboardsService } from "../src/services/dashboard.service";
import { EntitiesService } from "../src/services/entities.service";
import { saveAction } from "../src/modules/actions/service";
import { setProperties, upsertObject } from "../src/modules/catalog/service";
import { DecisionsService } from "../src/services/decision.service";
import { EventsService } from "../src/services/event.service";
import { LabelsService } from "../src/services/label.service";
import { ObjectsService } from "../src/services/object.service";
import { WebhooksService } from "../src/services/webhook.service";
import { SessionsService } from "../src/services/session.service";
import { UsersService } from "../src/services/user.service";
import { WorkspacesService } from "../src/services/workspace.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const accounts = tenancyRepository(database.db);
const keysIn = (workspaceId: string) => new ApiKeysService(database.db, { workspaceId });
const actionsIn = (workspaceId: string, environmentId: string) =>
  new ActionsService(database.db, { workspaceId, environmentId });
const entityTypesIn = (workspaceId: string, environmentId: string) =>
  new EntitiesService(database.db, { workspaceId, environmentId });
const queuesIn = (workspaceId: string, environmentId: string) =>
  new QueuesService(repos.db, { workspaceId, environmentId });
const dashboardsIn = (workspaceId: string, environmentId: string) =>
  new DashboardsService(database.db, { workspaceId, environmentId });
const objectsIn = (workspaceId: string, environmentId: string) =>
  new ObjectsService(database.db, { workspaceId, environmentId });
const labelsIn = (workspaceId: string, environmentId: string) =>
  new LabelsService(database.db, { workspaceId, environmentId });
const decisionsIn = (workspaceId: string, environmentId: string) =>
  new DecisionsService(database.db, { workspaceId, environmentId });
const eventsIn = (workspaceId: string, environmentId: string) =>
  new EventsService(database.db, { workspaceId, environmentId });
const users = new UsersService(database.db);
const sessions = new SessionsService(database.db);
const repos = createRepositories(database.db);
const environmentRepo = environmentsRepository(database.db);
const NOW = new Date("2026-10-23T12:00:00Z");
let app: ReturnType<typeof createApp>;
let workspace: string;
let owner: string;
let cookie: string;
let production: EnvironmentRow;
let sandbox: Environment;
let prodKey: string;
let sandboxKey: string;
let seen: GraysonRequest[];
let pending: Promise<unknown>[];
const base = () => `/app/workspaces/${workspace}`;

const call = async (
  method: string,
  path: string,
  body?: unknown,
  scope: { environment?: string; key?: string; cookie?: string } = {},
) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Kairos-Workspace": workspace,
      ...(scope.key ? { Authorization: `Bearer ${scope.key}` } : { Cookie: scope.cookie ?? cookie }),
      ...(scope.environment === undefined ? {} : { "X-Kairos-Environment": scope.environment }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
const event = (marker: string, id = "same-event") => ({
  id,
  type: "payment",
  ts: new Date(NOW.getTime() - 60_000).toISOString(),
  entities: { user: "user_42", device: "same-device" },
  properties: { marker, usd: 42 },
  session: "same-session",
  universal_id: "same-record",
});
const action = { subject: "user", hold: "Should this payment be held?", trigger: "payment" };

beforeEach(async () => {
  await database.reset();
  seen = [];
  pending = [];
  const user = await users.createWithAuth(
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
  cookie = `kairos_session=${(await sessions.start(owner, NOW)).token}`;
  const key = (name: string, environmentId: string) =>
    keysIn(workspace).createWithSecret(
      { environmentId, name, kind: "secret", allowedIps: [], allowedOrigins: [], createdBy: owner },
      NOW,
    );
  prodKey = (await key("Production", production.id)).secret;
  sandboxKey = (await key("Development", sandbox.id)).secret;
  const decider = async (request: GraysonRequest) => {
    seen.push(request);
    return {
      id: "d",
      model: "test",
      answers: { hold: { type: "noul" as const, value: false, probability: 0.1 } },
      usage: { input_tokens: 1 },
    };
  };
  const webhooks = {
    db: database.db,
    secretBox: secretBox(randomBytes(32)),
    allowPrivate: true,
    worker: { wake() {} } as never,
  };
  const automatic = createAutomatic({ repos, decider, now: () => NOW, webhooks, wake: () => runner.wake() });
  const runner = createJobs({
    repo: repos.jobs,
    kinds: [automatic.kind],
    now: () => NOW,
    defer: (work) => pending.push(work),
    log: () => {},
  });
  app = createApp({
    accounts,
    environments: environmentRepo,
    repos,
    decider,
    now: () => NOW,
    webhooks,
    automatic,
  });
});

it("creates one production environment and allows multiple named sandboxes", async () => {
  expect(
    (await new EnvironmentsService(database.db, { workspaceId: workspace }).list()).filter(
      (e) => e.kind === "production",
    ),
  ).toHaveLength(1);
  expect((await call("POST", `${base()}/environments`, { name: "Staging" })).status).toBe(201);
  expect((await call("POST", `${base()}/environments`, { name: "staging" })).status).toBe(409);
  expect((await call("POST", `${base()}/environments`, { name: "Another", kind: "production" })).status).toBe(400);
  await expect(
    database.db.insert(environments).values({
      id: "second-prod",
      workspaceId: workspace,
      name: "Another",
      kind: "production",
      created: NOW,
      updated: NOW,
    }),
  ).rejects.toThrow();
  expect((await call("PATCH", `${base()}/environments/${production.id}`, { name: "Renamed" })).status).toBe(409);
  expect((await call("DELETE", `${base()}/environments/${production.id}`, { confirm: "Production" })).status).toBe(409);
  expect((await call("PATCH", `${base()}/environments/${sandbox.id}`, { name: "Local" })).body.name).toBe("Local");
});

it("uses the key's environment even when the caller sends a different environment header", async () => {
  await call("PUT", "/v1/actions/payment", action, { key: prodKey, environment: sandbox.id });
  expect((await call("GET", "/v1/actions", undefined, { key: prodKey })).body.actions).toHaveLength(1);
  expect(
    (await call("GET", "/v1/actions", undefined, { key: sandboxKey, environment: production.id })).body.actions,
  ).toHaveLength(0);
  // Older console clients default to production; an invalid selection never falls back.
  expect((await call("GET", "/v1/actions")).body.actions).toHaveLength(1);
  expect((await call("GET", "/v1/actions", undefined, { environment: "missing" })).status).toBe(404);
  const key = await call(
    "POST",
    `${base()}/keys`,
    { name: "Sandbox browser", kind: "public" },
    { environment: sandbox.id },
  );
  expect(key.body.key.environment_id).toBe(sandbox.id);
  expect(
    (await call("GET", `${base()}/keys`, undefined, { environment: production.id })).body.keys.map((k: any) => k.name),
  ).toEqual(["Production"]);
  expect(
    (await call("POST", "/v1/events", { batch: [event("sandbox-public")] }, { key: key.body.secret })).status,
  ).toBe(202);
  expect((await call("GET", "/v1/actions", undefined, { key: key.body.secret })).status).toBe(403);
  expect((await repos.analytics.stats(workspace, production.id)).events).toBe(0);
});

it("keeps identical event, customer, session and record IDs separate, including decision context and metrics", async () => {
  for (const [key, marker] of [
    [prodKey, "production-only"],
    [sandboxKey, "sandbox-only"],
  ]) {
    expect((await call("POST", "/v1/events", { batch: [event(marker!)] }, { key })).body.accepted).toBe(1);
    expect((await call("POST", "/v1/events", { batch: [event(marker!)] }, { key })).body.duplicates).toBe(1);
    await call("PUT", "/v1/actions/payment", action, { key });
    await call("PUT", "/v1/entities/user/user_42", { properties: { marker } }, { key });
  }
  await call(
    "POST",
    "/v1/labels",
    { batch: [{ entity: { type: "user", id: "user_42" }, label: "sandbox_label" }] },
    { key: sandboxKey },
  );
  for (const [key, own, other] of [
    [prodKey, "production-only", "sandbox-only"],
    [sandboxKey, "sandbox-only", "production-only"],
  ]) {
    expect(
      (
        await call(
          "POST",
          "/v1/decide",
          { action: "payment", entities: { user: "user_42", device: "same-device" }, properties: {} },
          { key },
        )
      ).status,
    ).toBe(200);
    const context = JSON.stringify(seen.at(-1));
    expect(context).toContain(own);
    expect(context).not.toContain(other);
    if (key === prodKey) expect(context).not.toContain("sandbox_label");
    const customer = (await call("GET", "/v1/entities/user/user_42", undefined, { key })).body;
    expect(customer.events).toHaveLength(1);
    expect(customer.decisions).toHaveLength(1);
    expect(customer.sessions).toHaveLength(1);
    expect((await call("GET", "/v1/usage", undefined, { key })).body.stored).toMatchObject({ events: 1, decisions: 1 });
  }
  expect(
    (await eventsIn(workspace, production.id).listStages("same-record", NOW.toISOString()))[0]!.properties.marker,
  ).toBe("production-only");
  expect((await repos.entities.labelRates(workspace, production.id, "user")).labels).toEqual({});
});

it("checks workspace membership and restricts sandbox management to admins", async () => {
  const member = await users.createWithAuth(
    {
      email: "member@example.com",
      displayName: "Member",
      auth: { provider: "native", strategy: "email_password" },
      passwordHash: "x",
    },
    NOW,
  );
  await database.db.insert(memberships).values({
    id: `mem_${member.id}`,
    workspaceId: workspace,
    userId: member.id,
    role: "member",
    created: NOW,
    updated: NOW,
  });
  const memberCookie = `kairos_session=${(await sessions.start(member.id, NOW)).token}`;
  expect((await call("GET", `${base()}/environments`, undefined, { cookie: memberCookie })).status).toBe(200);
  expect((await call("GET", "/v1/stats", undefined, { cookie: memberCookie, environment: sandbox.id })).status).toBe(
    200,
  );
  expect((await call("POST", `${base()}/environments`, { name: "Forbidden" }, { cookie: memberCookie })).status).toBe(
    403,
  );
  const other = await accounts.createWorkspace("Other", member.id, NOW);
  const foreign = (await new EnvironmentsService(database.db, { workspaceId: other.id }).findByIdOrProduction())!;
  expect((await call("GET", "/v1/stats", undefined, { environment: foreign.id })).status).toBe(404);
  expect(
    (await call("POST", `${base()}/keys`, { name: "Foreign", kind: "secret", environment_id: foreign.id })).status,
  ).toBe(404);
  expect((await call("POST", `${base()}/environments`, { name: "Foreign copy", copy_from: foreign.id })).status).toBe(
    404,
  );
  expect((await call("GET", `/app/workspaces/${other.id}/environments`)).status).toBe(404);
});

it("enforces both workspace and environment in storage, even when callers bypass HTTP authentication", async () => {
  const other = await accounts.createWorkspace("Independent workspace", owner, NOW);
  await saveAction(repos.db, workspace, production.id, { name: "payment", ...action }, NOW);
  await repos.events.insertEvents(workspace, production.id, [event("production")], NOW.toISOString());
  expect(await actionsIn(other.id, production.id).listLatest()).toEqual([]);
  expect(
    await repos.events.timeline(other.id, production.id, { type: "user", id: "user_42" }, 100, NOW.toISOString()),
  ).toEqual([]);
  expect((await repos.analytics.stats(other.id, production.id)).events).toBe(0);
  await expect(
    repos.events.insertEvents(other.id, production.id, [event("wrong-workspace", "new-id")], NOW.toISOString()),
  ).rejects.toThrow();
  await expect(saveAction(repos.db, other.id, production.id, { name: "wrong", ...action }, NOW)).rejects.toThrow();
});

it("copies current configuration independently, respecting private dashboards and leaving credentials and data empty", async () => {
  await saveAction(repos.db, workspace, production.id, { name: "payment", ...action, automatic: true }, NOW);
  await saveAction(
    repos.db,
    workspace,
    production.id,
    { name: "payment", ...action, hold: "A newer question?", automatic: true },
    NOW,
  );
  await entityTypesIn(workspace, production.id).save({ type: "user", description: "A customer" }, NOW);
  await repos.events.insertEvents(workspace, production.id, [event("history")], NOW.toISOString());
  for (const [id, visibility, user] of [
    ["shared", "workspace", owner],
    ["mine", "private", owner],
    ["theirs", "private", "someone-else"],
  ] as const) {
    await dashboardsIn(workspace, production.id).create(
      { definition: { name: id, visibility, tiles: [], range: "30d" }, owner: user },
      NOW,
      { id },
    );
  }
  const copy = await call("POST", `${base()}/environments`, {
    name: "Experiment",
    copy_from: production.id,
    copy_dashboards: true,
  });
  expect(copy.status).toBe(201);
  const id = copy.body.id;
  expect(await actionsIn(workspace, id).findLatest("payment")).toMatchObject({
    hold: "A newer question?",
    version: 1,
  });
  expect((await actionsIn(workspace, id).findLatest("payment"))!.automatic).toBeUndefined();
  expect(await entityTypesIn(workspace, id).findByType("user")).toMatchObject({ description: "A customer" });
  expect((await dashboardsIn(workspace, id).list()).map((d) => d.definition.name).sort()).toEqual(["mine", "shared"]);
  expect((await repos.analytics.stats(workspace, id)).events).toBe(0);
  expect(await keysIn(workspace).list(id)).toEqual([]);
  expect(await new WebhooksService(database.db, { workspaceId: workspace, environmentId: id }).list()).toEqual([]);
  await saveAction(repos.db, workspace, id, { name: "payment", ...action, hold: "Only in sandbox?" }, NOW);
  expect((await actionsIn(workspace, production.id).findLatest("payment"))!.hold).toBe("A newer question?");
});

const seedSelectableCopy = async () => {
  await entityTypesIn(workspace, production.id).save({ type: "user", description: "A customer" }, NOW);
  await setProperties(
    repos.db,
    workspace,
    production.id,
    { type: "user", id: "user_42" },
    { set: { name: "Original customer", score: 10 } },
    NOW.toISOString(),
    NOW.toISOString(),
  );
  await labelsIn(workspace, production.id).save(
    { type: "user", id: "user_42" },
    { label: "verified", ts: NOW.toISOString(), properties: { reason: "checked" } },
    NOW,
  );
  await call("POST", `${base()}/webhooks`, {
    direction: "out",
    name: "Source only",
    url: "https://example.com/hooks",
    events: ["decision.created"],
  });
  const ids: string[] = [];
  for (const version of [1, 2]) {
    await saveAction(
      repos.db,
      workspace,
      production.id,
      { name: "payment", ...action, hold: `Question version ${version}?` },
      NOW,
    );
    const answer = await call(
      "POST",
      "/v1/events/decide",
      { ...event("history", `event-${version}`), status: "pending" },
      { key: prodKey },
    );
    expect(answer.status).toBe(200);
    ids.push(answer.body.decision_id);
  }
  await decisionsIn(workspace, production.id).resolve(
    ids[0]!,
    { outcome: "block", note: "Reviewed", by: owner, at: NOW.toISOString() },
    NOW,
  );
  await saveAction(
    repos.db,
    workspace,
    production.id,
    { name: "payment", ...action, hold: "Question version 2?", automatic: true },
    NOW,
  );
  for (const [id, visibility, user] of [
    ["shared", "workspace", owner],
    ["mine", "private", owner],
    ["theirs", "private", "another-user"],
  ] as const) {
    await dashboardsIn(workspace, production.id).create(
      { definition: { name: id, visibility, tiles: [], range: "30d" }, owner: user },
      NOW,
      { id },
    );
    await queuesIn(workspace, production.id).create(
      {
        definition: {
          name: id,
          visibility,
          sources: { actions: ["payment"] },
          intake: [],
          correlation: { by: "subject" },
        },
        owner: user,
        version: 2,
      },
      NOW,
      { id: `que_${id}` },
    );
  }
  return ids;
};

it.each(["entities", "actions", "events", "dashboards", "queues", "decisions"] as const)(
  "copies only selected %s, including the documented history dependencies",
  async (category) => {
    const decisionIds = await seedSelectableCopy();
    const before = await repos.analytics.stats(workspace, production.id);
    const answer = await call("POST", `${base()}/environments`, {
      name: `Only ${category}`,
      copy_from: production.id,
      copy: { [category]: true },
    });
    expect(answer.status).toBe(201);
    const target = answer.body.id;
    const hasEvents = category === "events" || category === "decisions";
    const hasActions = category === "actions" || category === "decisions";
    const stats = await repos.analytics.stats(workspace, target);
    expect(stats.events).toBe(hasEvents ? 2 : 0);
    expect(stats.decisions).toBe(category === "decisions" ? 2 : 0);
    expect((await actionsIn(workspace, target).listLatest()).length).toBe(hasActions ? 1 : 0);
    expect(await entityTypesIn(workspace, target).findByType("user")).toEqual(
      category === "entities" ? await entityTypesIn(workspace, production.id).findByType("user") : null,
    );
    expect((await dashboardsIn(workspace, target).list()).map((d) => d.definition.name).sort()).toEqual(
      category === "dashboards" ? ["mine", "shared"] : [],
    );
    expect((await queuesIn(workspace, target).list()).map((q) => [q.definition.name, q.version]).sort()).toEqual(
      category === "queues"
        ? [
            ["mine", 2],
            ["shared", 2],
          ]
        : [],
    );
    if (category === "entities") {
      expect(await objectsIn(workspace, target).findByEntity({ type: "user", id: "user_42" })).toEqual(
        await objectsIn(workspace, production.id).findByEntity({ type: "user", id: "user_42" }),
      );
      expect(await labelsIn(workspace, target).listFor({ type: "user", id: "user_42" })).toEqual(
        await labelsIn(workspace, production.id).listFor({ type: "user", id: "user_42" }),
      );
      // This device exists only through events in the source, without a stored profile.
      expect(
        (await repos.entities.listEntities(workspace, target, { type: "device", limit: 10, offset: 0 })).map(
          (e) => e.id,
        ),
      ).toEqual(["same-device"]);
      await upsertObject(
        repos.db,
        workspace,
        target,
        { type: "user", id: "user_42" },
        { name: "Sandbox customer" },
        NOW.toISOString(),
      );
      expect(
        (await objectsIn(workspace, production.id).findByEntity({ type: "user", id: "user_42" }))!.properties.name,
      ).toBe("Original customer");
    } else {
      expect(await objectsIn(workspace, target).findByEntity({ type: "user", id: "user_42" })).toBeNull();
      expect(await labelsIn(workspace, target).listFor({ type: "user", id: "user_42" })).toEqual([]);
    }
    if (hasEvents) {
      expect(
        await repos.events.timeline(workspace, target, { type: "user", id: "user_42" }, 10, NOW.toISOString()),
      ).toEqual(
        await repos.events.timeline(workspace, production.id, { type: "user", id: "user_42" }, 10, NOW.toISOString()),
      );
      expect(await eventsIn(workspace, target).listInSession("same-session", NOW.toISOString(), 10)).toHaveLength(2);
      expect(await eventsIn(workspace, target).listStages("same-record", NOW.toISOString())).toHaveLength(2);
    }
    if (hasActions) {
      const latest = (await actionsIn(workspace, target).findLatest("payment"))!;
      expect(latest.automatic).toBeUndefined();
      expect(latest.version).toBe(category === "decisions" ? 2 : 1);
    }
    if (category === "decisions") {
      // A copy is a new row: the same decision, about the copied event, with an id of its own.
      for (const id of decisionIds) {
        const original = (await decisionsIn(workspace, production.id).findRecord(id))!;
        const copied = (await decisionsIn(workspace, target).findByEvent(original.event_id!))!;
        expect(copied.id).not.toBe(id);
        expect(copied).toEqual({ ...original, id: copied.id });
      }
      const { rows } = await database.db.execute<Record<string, any>>(
        sql`SELECT version FROM definition_versions WHERE workspace_id = ${workspace} AND environment_id = ${target} AND kind = 'action' ORDER BY version`,
      );
      expect(rows.map((r) => r.version)).toEqual([1, 2]);
      // Preserve raw ordered JSON and generated outcomes as well as the public record.
      const original = await database.db.execute<Record<string, any>>(
        sql`SELECT context::text, raw::text, request::text, final_outcome FROM decisions WHERE workspace_id = ${workspace} AND environment_id = ${production.id} ORDER BY ts, context::text`,
      );
      const copied = await database.db.execute<Record<string, any>>(
        sql`SELECT context::text, raw::text, request::text, final_outcome FROM decisions WHERE workspace_id = ${workspace} AND environment_id = ${target} ORDER BY ts, context::text`,
      );
      expect(copied.rows).toEqual(original.rows);
    }
    expect(await keysIn(workspace).list(target)).toEqual([]);
    expect(await new WebhooksService(database.db, { workspaceId: workspace, environmentId: target }).list()).toEqual(
      [],
    );
    expect(
      await database.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.environmentId, target)),
    ).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(await repos.analytics.stats(workspace, production.id)).toEqual(before);
  },
);

it("accepts an empty selection and rejects unknown categories or copy requests without a source", async () => {
  await saveAction(repos.db, workspace, production.id, { name: "payment", ...action }, NOW);
  const empty = await call("POST", `${base()}/environments`, {
    name: "Empty selection",
    copy_from: production.id,
    copy: {},
  });
  expect(empty.status).toBe(201);
  expect(await actionsIn(workspace, empty.body.id).listLatest()).toEqual([]);
  expect((await call("POST", `${base()}/environments`, { name: "No source", copy: { events: true } })).status).toBe(
    400,
  );
  expect(
    (
      await call("POST", `${base()}/environments`, {
        name: "Unknown",
        copy_from: production.id,
        copy: { credentials: true },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("POST", `${base()}/environments`, {
        name: "Ambiguous",
        copy_from: production.id,
        copy: {},
        copy_dashboards: true,
      })
    ).status,
  ).toBe(400);
});

it("copies exact action, entity, event, and dashboard selections without unrelated records", async () => {
  await seedSelectableCopy();
  await saveAction(repos.db, workspace, production.id, { name: "unselected_action", ...action }, NOW);
  await upsertObject(
    repos.db,
    workspace,
    production.id,
    { type: "user", id: "unselected_user" },
    { name: "Leave here" },
    NOW.toISOString(),
  );
  await upsertObject(
    repos.db,
    workspace,
    production.id,
    { type: "device", id: "user_42" },
    { name: "Same ID, different type" },
    NOW.toISOString(),
  );
  const answer = await call("POST", `${base()}/environments`, {
    name: "Exact selection",
    copy_from: production.id,
    copy: {
      actions: { ids: ["payment"] },
      entities: { records: [{ type: "user", id: "user_42" }] },
      events: { ids: ["event-1"] },
      dashboards: { ids: ["mine"] },
    },
  });
  expect(answer.status).toBe(201);
  const target = answer.body.id;
  expect((await actionsIn(workspace, target).listLatest()).map((a) => a.name)).toEqual(["payment"]);
  expect(await actionsIn(workspace, target).findLatest("payment")).toMatchObject({
    version: 1,
    hold: "Question version 2?",
  });
  expect((await objectsIn(workspace, target).findByEntity({ type: "user", id: "user_42" }))!.properties.name).toBe(
    "Original customer",
  );
  expect(await objectsIn(workspace, target).findByEntity({ type: "user", id: "unselected_user" })).toBeNull();
  expect(await objectsIn(workspace, target).findByEntity({ type: "device", id: "user_42" })).toBeNull();
  expect(await objectsIn(workspace, target).findByEntity({ type: "device", id: "same-device" })).toBeNull();
  expect(
    (await repos.events.timeline(workspace, target, { type: "user", id: "user_42" }, 10, NOW.toISOString())).map(
      (e) => e.id,
    ),
  ).toEqual(["event-1"]);
  expect((await dashboardsIn(workspace, target).list()).map((d) => d.definition.name)).toEqual(["mine"]);
  expect((await repos.analytics.stats(workspace, target)).decisions).toBe(0);
});

it("supports whole entity and event types together with individual records", async () => {
  await seedSelectableCopy();
  await upsertObject(
    repos.db,
    workspace,
    production.id,
    { type: "user", id: "another_user" },
    { name: "Another" },
    NOW.toISOString(),
  );
  await repos.events.insertEvents(
    workspace,
    production.id,
    [{ ...event("other", "other-event"), type: "other" }],
    NOW.toISOString(),
  );
  const answer = await call("POST", `${base()}/environments`, {
    name: "Types and records",
    copy_from: production.id,
    copy: {
      entities: { types: ["user"], records: [{ type: "device", id: "same-device" }] },
      events: { types: ["other"], ids: ["event-1"] },
    },
  });
  expect(answer.status).toBe(201);
  const target = answer.body.id;
  expect(
    (await repos.entities.listEntities(workspace, target, { type: "user", limit: 10, offset: 0 }))
      .map((e) => e.id)
      .sort(),
  ).toEqual(["another_user", "user_42"]);
  expect(await objectsIn(workspace, target).findByEntity({ type: "device", id: "same-device" })).not.toBeNull();
  expect(
    (await repos.events.timeline(workspace, target, { type: "user", id: "user_42" }, 10, NOW.toISOString()))
      .map((e) => e.id)
      .sort(),
  ).toEqual(["event-1", "other-event"]);
  expect(await actionsIn(workspace, target).listLatest()).toEqual([]);
});

it("copies only the triggering event and required action version for a selected decision", async () => {
  const ids = await seedSelectableCopy();
  await saveAction(repos.db, workspace, production.id, { name: "unrelated_action", ...action }, NOW);
  await repos.events.insertEvents(workspace, production.id, [event("unrelated", "unrelated-event")], NOW.toISOString());
  const answer = await call("POST", `${base()}/environments`, {
    name: "One decision",
    copy_from: production.id,
    copy: { decisions: { ids: [ids[0]] }, actions: false, events: false },
  });
  expect(answer.status).toBe(201);
  const target = answer.body.id;
  const original = (await decisionsIn(workspace, production.id).findRecord(ids[0]!))!;
  const copied = (await decisionsIn(workspace, target).findByEvent("event-1"))!;
  expect(copied).toEqual({ ...original, id: copied.id });
  expect(await decisionsIn(workspace, target).findByEvent("event-2")).toBeNull();
  expect(await repos.analytics.stats(workspace, target)).toMatchObject({ events: 1, decisions: 1 });
  expect((await actionsIn(workspace, target).listLatest()).map((a) => [a.name, a.version, a.hold])).toEqual([
    ["payment", 1, "Question version 1?"],
  ]);
  expect(
    (await repos.events.timeline(workspace, target, { type: "user", id: "user_42" }, 10, NOW.toISOString())).map(
      (e) => e.id,
    ),
  ).toEqual(["event-1"]);
});

it("browses source-specific choices with search and pagination, excluding private dashboards", async () => {
  await seedSelectableCopy();
  const path = `${base()}/environments/${production.id}/copy-options`;
  for (const [category, total] of [
    ["actions", 1],
    ["entities", 2],
    ["entity_types", 2],
    ["event_types", 1],
    ["events", 2],
    ["decisions", 2],
    ["dashboards", 2],
  ] as const) {
    const answer = await call("GET", `${path}?category=${category}`);
    expect(answer.status, category).toBe(200);
    expect(answer.body.total, category).toBe(total);
  }
  const first = (await call("GET", `${path}?category=events&limit=1`)).body;
  const second = (await call("GET", `${path}?category=events&limit=1&offset=1`)).body;
  expect(first.items[0].id).not.toBe(second.items[0].id);
  expect(second.total).toBe(2);
  expect((await call("GET", `${path}?category=events&limit=1&offset=10`)).body).toEqual({ items: [], total: 2 });
  expect((await call("GET", `${path}?category=entities&q=Original`)).body.items).toMatchObject([
    { id: "user_42", type: "user" },
  ]);
  expect((await call("GET", `${path}?category=actions&q=%25`)).body.total).toBe(0);
  expect((await call("GET", `${path}?category=dashboards&q=theirs`)).body.total).toBe(0);
  expect((await call("GET", `${path}?category=unknown`)).status).toBe(400);
  expect((await call("GET", `${path}?category=events&offset=-1`)).status).toBe(400);
  expect((await call("GET", `${base()}/environments/${sandbox.id}/copy-options?category=events`)).body.total).toBe(0);
  const member = await users.createWithAuth(
    {
      email: "copy-member@example.com",
      displayName: "Member",
      auth: { provider: "native", strategy: "email_password" },
      passwordHash: "x",
    },
    NOW,
  );
  await database.db.insert(memberships).values({
    id: `mem_${member.id}`,
    workspaceId: workspace,
    userId: member.id,
    role: "member",
    created: NOW,
    updated: NOW,
  });
  const memberCookie = `kairos_session=${(await sessions.start(member.id, NOW)).token}`;
  expect((await call("GET", `${path}?category=events`, undefined, { cookie: memberCookie })).status).toBe(403);
});

it("rejects unavailable, foreign, and private selections atomically and treats empty lists as empty", async () => {
  const ids = await seedSelectableCopy();
  const before = await new EnvironmentsService(database.db, { workspaceId: workspace }).list();
  for (const copy of [
    { actions: { ids: ["missing"] } },
    { dashboards: { ids: ["theirs"] } },
    { entities: { records: [{ type: "device", id: "user_42" }] } },
    { events: { types: ["missing"] } },
    { decisions: { ids: ["missing"] } },
  ]) {
    const answer = await call("POST", `${base()}/environments`, {
      name: "Invalid selection",
      copy_from: production.id,
      copy,
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.type).toBe("invalid_copy_selection");
    expect(await new EnvironmentsService(database.db, { workspaceId: workspace }).list()).toEqual(before);
  }
  expect(
    (
      await call("POST", `${base()}/environments`, {
        name: "Wrong source",
        copy_from: sandbox.id,
        copy: { decisions: { ids: [ids[0]] } },
      })
    ).status,
  ).toBe(400);
  const empty = await call("POST", `${base()}/environments`, {
    name: "Empty lists",
    copy_from: production.id,
    copy: {
      actions: { ids: [] },
      entities: { records: [], types: [] },
      events: { ids: [], types: [] },
      dashboards: { ids: [] },
      decisions: { ids: [] },
    },
  });
  expect(empty.status).toBe(201);
  expect(await repos.analytics.stats(workspace, empty.body.id)).toMatchObject({ events: 0, decisions: 0, actions: 0 });
  expect(await entityTypesIn(workspace, empty.body.id).findByType("user")).toBeNull();
});

it("rolls back the sandbox and earlier copied categories when copying history fails", async () => {
  await seedSelectableCopy();
  const before = await new EnvironmentsService(database.db, { workspaceId: workspace }).list();
  const sourceStats = await repos.analytics.stats(workspace, production.id);
  await database.db.execute<
    Record<string, any>
  >(sql`CREATE FUNCTION test_reject_event_copy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Simulated copy failure'; END $$`);
  try {
    await database.db.execute<Record<string, any>>(
      sql`CREATE TRIGGER test_reject_event_copy BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION test_reject_event_copy()`,
    );
    await expect(
      environmentRepo.createSandbox(
        workspace,
        {
          name: "Interrupted copy",
          copy_from: production.id,
          copy: { entities: true, actions: true, events: true, dashboards: true, decisions: true },
        },
        owner,
        NOW,
      ),
    ).rejects.toThrow();
    expect(await new EnvironmentsService(database.db, { workspaceId: workspace }).list()).toEqual(before);
    expect(await repos.analytics.stats(workspace, production.id)).toEqual(sourceStats);
  } finally {
    await database.db.execute<Record<string, any>>(sql`DROP TRIGGER IF EXISTS test_reject_event_copy ON events`);
    await database.db.execute<Record<string, any>>(sql`DROP FUNCTION test_reject_event_copy()`);
  }
});

it("scopes automatic decisions and outbound deliveries to the triggering environment", async () => {
  for (const environment of [production, sandbox]) {
    await call(
      "POST",
      `${base()}/webhooks`,
      { direction: "out", name: "Decisions", url: "https://example.com/hooks", events: ["decision.created"] },
      { environment: environment.id },
    );
  }
  await call("PUT", "/v1/actions/payment", { ...action, automatic: true }, { key: sandboxKey });
  await call("POST", "/v1/events", { batch: [event("sandbox-only")] }, { key: sandboxKey });
  await call("POST", "/v1/events", { batch: [event("production-only")] }, { key: prodKey });
  await settle();
  expect(await decisionsIn(workspace, production.id).listSummaries({ limit: 10 })).toHaveLength(0);
  expect(await decisionsIn(workspace, sandbox.id).listSummaries({ limit: 10 })).toHaveLength(1);
  const deliveries = await database.db.select().from(webhookDeliveries);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.environmentId).toBe(sandbox.id);
  expect(deliveries[0]!.payload).toMatchObject({ workspace_id: workspace, environment_id: sandbox.id });
  const sandboxHook = (
    await new WebhooksService(database.db, { workspaceId: workspace, environmentId: sandbox.id }).list()
  )[0]!;
  expect(
    (await call("GET", `${base()}/webhooks/${sandboxHook.id}`, undefined, { environment: production.id })).status,
  ).toBe(404);
});

it("deletes only a confirmed sandbox and invalidates its keys", async () => {
  await repos.events.insertEvents(workspace, production.id, [event("production")], NOW.toISOString());
  await repos.events.insertEvents(workspace, sandbox.id, [event("sandbox")], NOW.toISOString());
  expect((await call("DELETE", `${base()}/environments/${sandbox.id}`, { confirm: "wrong" })).status).toBe(400);
  expect((await call("DELETE", `${base()}/environments/${sandbox.id}`, { confirm: sandbox.name })).status).toBe(200);
  expect(await ApiKeysService.findBySecret(database.db, sandboxKey)).toBeNull();
  expect((await call("GET", "/v1/stats", undefined, { key: sandboxKey })).status).toBe(401);
  expect((await repos.analytics.stats(workspace, production.id)).events).toBe(1);
  expect(await ApiKeysService.findBySecret(database.db, prodKey)).not.toBeNull();
  await new WorkspacesService(database.db).delete(workspace);
  expect(await database.db.select().from(environments).where(eq(environments.workspaceId, workspace))).toHaveLength(0);
});
