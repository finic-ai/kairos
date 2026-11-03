import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ALL_TABLES } from "../src/db/schema";
import { secretBox } from "../src/platform/secrets";
import { JobsService } from "../src/services/job.service";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { createWebhookWorker } from "../src/modules/webhooks/libs";
import { evaluateDecision } from "../src/modules/cases/service";
import { testDatabase } from "./helpers/database";

/**
 * `created` is when Kairos wrote a row, and `updated` when the row last changed. Both come from the
 * clock that the service is given, never from the database default: the fixed clock here is months
 * away from the real one, so a write that left them to the default would show.
 */
const database = await testDatabase();
const T1 = new Date("2026-01-01T00:00:00Z");
const T2 = new Date("2026-01-01T01:00:00Z");
let clock = T1;

const worker = createWebhookWorker({
  db: database.db,
  jobs: new JobsService(database.db),
  secretBox: secretBox(randomBytes(32)),
  now: () => clock,
  allowPrivate: true,
  log: () => {},
});
const repos = createRepositories(database.db);
const app = createApp({
  repos,
  accounts: tenancyRepository(database.db),
  environments: environmentsRepository(database.db),
  decider: async () => ({
    id: "d",
    model: "grayson-1",
    answers: { hold: { type: "noul", value: false, probability: 0.1 } },
    usage: { input_tokens: 1 },
  }),
  now: () => clock,
  webhooks: {
    db: database.db,
    secretBox: secretBox(randomBytes(32)),
    worker: { ...worker, wake: () => {} },
    allowPrivate: true,
  },
});

let cookie = "";
let workspace = "";
const call = async (method: string, path: string, body?: unknown, as = cookie) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: as,
      ...(path.startsWith("/v1") ? { "X-Kairos-Workspace": workspace } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return { response, body: json };
};
const signup = async (email: string, invite?: string) => {
  const { response, body } = await call(
    "POST",
    "/auth/signup",
    { email, password: "correct horse", name: "Test", ...(invite ? { invite } : {}) },
    "",
  );
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!, body };
};

/** The created and updated of every row of a table, as times in milliseconds. */
const times = async (table: string) => {
  const hasUpdated =
    (
      await database.db.execute<Record<string, any>>(
        sql`SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = 'updated'`,
      )
    ).rows.length > 0;
  const found = await database.db.execute<Record<string, any>>(
    sql.raw(
      `SELECT extract(epoch FROM created) * 1000 AS created${hasUpdated ? ", extract(epoch FROM updated) * 1000 AS updated" : ""} FROM ${table}`,
    ),
  );
  return found.rows.map((r) => ({ created: Number(r.created), ...(hasUpdated ? { updated: Number(r.updated) } : {}) }));
};

let ids: {
  decision: string;
  dashboard: string;
  webhook: string;
  key: string;
  sandbox: string;
  member: string;
  queue: string;
  case: string;
  payoutQueue: Record<string, unknown>;
};

beforeAll(async () => {
  await database.reset();
  ({ cookie } = await signup("owner@example.com"));
  workspace = (await call("GET", "/auth/me")).body.workspaces[0].id;
  const ws = `/app/workspaces/${workspace}`;
  const key = (await call("POST", `${ws}/keys`, { name: "server", kind: "secret" })).body.key.id;
  const invite = (await call("POST", `${ws}/invites`, { email: "member@example.com" })).body.token;
  const member = (await signup("member@example.com", invite)).body.user.id;
  const sandbox = (await call("POST", `${ws}/environments`, { name: "Development" })).body.id;
  await call("PUT", "/v1/entity-types/user", { description: "A person" });
  await call("PUT", "/v1/actions/payout", {
    subject: "user",
    hold: "Should this payout be held?",
    trigger: { event: "payout" },
  });
  const payoutQueue = {
    name: "Payouts",
    visibility: "workspace",
    sources: { actions: ["payout"] },
    intake: [{ id: "all", name: "All", conditions: { all: [{ field: "decision.risk_score", op: ">=", value: 0 }] } }],
    correlation: { by: "subject" },
  };
  const queue = (await call("POST", "/v1/queues", payoutQueue)).body.id;
  const webhook = (
    await call("POST", `${ws}/webhooks`, {
      direction: "out",
      name: "Queue",
      url: "http://127.0.0.1:9/hook",
      events: ["decision.created", "decision.updated", "label.created"],
    })
  ).body.webhook.id;
  const decided = (
    await call("POST", "/v1/events/decide", {
      id: "p1",
      type: "payout",
      ts: T1.toISOString(),
      entities: { user: "u1" },
      properties: { usd: 10 },
      set: { user: { country: "GB" } },
    })
  ).body;
  // The case job, as the worker would run it: a case, its evidence, its items and its activity.
  const environmentId = (
    await database.db.execute<{ environment_id: string }>(sql`SELECT environment_id FROM decisions LIMIT 1`)
  ).rows[0]!.environment_id;
  const [opened] = await evaluateDecision(repos, { workspaceId: workspace, environmentId }, decided.decision_id, clock);
  await call("POST", "/v1/labels", {
    batch: [{ entity: { type: "user", id: "u1" }, label: "verified", ts: T1.toISOString() }],
  });
  const dashboard = (await call("POST", "/v1/dashboards", { name: "Payouts", visibility: "workspace", tiles: [] })).body
    .id;
  await call("PUT", "/v1/workflows/payout_check", {
    name: "payout_check",
    trigger: { type: "manual" },
    steps: [{ id: "wait", name: "Wait an hour", type: "delay", for: "1h" }],
  });
  await call("POST", "/v1/workflows/payout_check/runs", { input: {} });
  const model = JSON.parse(
    readFileSync(new URL("../../../packages/core/test/fixtures/xgboost/binary-3.0.2.json", import.meta.url), "utf8"),
  );
  await call("POST", "/v1/models/payout-risk/versions", {
    name: "Payout risk",
    format: "xgboost-json",
    model: model.model,
    samples: model.samples.slice(0, 100),
  });
  await call("POST", "/v1/workflows/payout_check/experiments", {
    labels: ["fraud"],
    window: "30d",
    subject: { type: "user", id: "{{ trigger.user }}" },
    features: { usd: "{{ trigger.usd }}" },
    variants: [{ key: "usd", name: "USD", model: { type: "probability", feature: "usd" } }],
  });
  await call("PUT", "/v1/rulesets/payout_rules/draft", {
    name: "Payout rules",
    definition: {
      rules: [{ id: "big", name: "Big", when: "input.usd > 100", outcome: "reject" }],
      default: { outcome: "approve" },
    },
  });
  await call("PUT", "/v1/lists/blocked_payees", { name: "Blocked payees" });
  ids = {
    decision: decided.decision_id,
    dashboard,
    webhook,
    key,
    sandbox,
    member,
    queue,
    case: opened!.case_id,
    payoutQueue,
  };
});

it("writes created and updated from the service's clock, for every table", async () => {
  const empty: string[] = [];
  for (const table of ALL_TABLES) {
    const rows = await times(table);
    if (rows.length === 0) empty.push(table);
    for (const row of rows)
      expect(row, table).toEqual({ created: T1.getTime(), ...("updated" in row ? { updated: T1.getTime() } : {}) });
  }
  expect(empty).toEqual([]);
});

it("changes updated, and keeps created, when a row changes", async () => {
  clock = T2;
  const ws = `/app/workspaces/${workspace}`;
  await call("PATCH", "/auth/me", { name: "Renamed" });
  await call("PATCH", ws, { name: "Renamed" });
  await call("PATCH", `${ws}/environments/${ids.sandbox}`, { name: "Staging" });
  await call("PATCH", `${ws}/members/${ids.member}`, { role: "admin" });
  await call("DELETE", `${ws}/keys/${ids.key}`);
  await call("PUT", "/v1/entity-types/user", { description: "A customer" });
  await call("PUT", "/v1/actions/payout", {
    subject: "user",
    hold: "Should this payout be held?",
    trigger: { event: "payout" },
    displayName: "Payouts",
  });
  await call("PUT", "/v1/entities/user/u1", { properties: { country: "FR" } });
  await call("PUT", `/v1/queues/${ids.queue}`, { ...ids.payoutQueue, name: "Renamed" });
  await call("POST", `/v1/cases/${ids.case}/notes`, { text: "Checked" });
  await call("POST", "/v1/labels", {
    batch: [{ entity: { type: "user", id: "u1" }, label: "verified", ts: T2.toISOString() }],
  });
  await call("POST", `/v1/decisions/${ids.decision}/resolution`, { outcome: "approve" });
  await call("PUT", `/v1/dashboards/${ids.dashboard}`, { name: "Payouts", visibility: "workspace", tiles: [] });
  await call("PATCH", `${ws}/webhooks/${ids.webhook}`, { name: "Renamed" });
  await call("PATCH", "/v1/models/payout-risk", { name: "Renamed" });
  await call("PATCH", "/v1/rulesets/payout_rules", { name: "Renamed" });
  await call("POST", "/v1/lists/blocked_payees/items", { items: [{ value: "payee_1" }] });
  // The first attempt of each delivery: the address refuses the connection, and the attempt is recorded.
  await worker.drain();

  const changed = async (table: string, where: string) =>
    (
      await database.db.execute<Record<string, any>>(
        sql.raw(
          `SELECT extract(epoch FROM created) * 1000 AS created, extract(epoch FROM updated) * 1000 AS updated FROM ${table} WHERE ${where}`,
        ),
      )
    ).rows.map((r) => ({ created: Number(r.created), updated: Number(r.updated) }));
  const expected = [{ created: T1.getTime(), updated: T2.getTime() }];
  expect(await changed("users", "email = 'owner@example.com'")).toEqual(expected);
  expect(await changed("workspaces", "true")).toEqual(expected);
  expect(await changed("environments", `id = '${ids.sandbox}'`)).toEqual(expected);
  expect(await changed("memberships", `user_id = '${ids.member}'`)).toEqual(expected);
  expect(await changed("api_keys", `id = '${ids.key}'`)).toEqual(expected);
  expect(await changed("entities", "true")).toEqual(expected);
  expect(await changed("actions", "true")).toEqual(expected);
  expect(await changed("objects", "true")).toEqual(expected);
  expect(await changed("labels", "true")).toEqual(expected);
  expect(await changed("decisions", "true")).toEqual(expected);
  expect(await changed("dashboards", "true")).toEqual(expected);
  expect(await changed("queues", "true")).toEqual(expected);
  expect(await changed("cases", "true")).toEqual(expected);
  expect(await changed("webhooks", "true")).toEqual(expected);
  expect(await changed("models", "true")).toEqual(expected);
  expect(await changed("rulesets", "true")).toEqual(expected);
  expect(await changed("lists", "true")).toEqual(expected);
  // The two deliveries from T1 were attempted at T2; the resolution added a third one, new at T2.
  expect(await changed("webhook_deliveries", "type <> 'decision.updated'")).toEqual([...expected, ...expected]);
  expect(await changed("webhook_deliveries", "type = 'decision.updated'")).toEqual([
    { created: T2.getTime(), updated: T2.getTime() },
  ]);
  // A row that a change did not touch keeps both times.
  expect(await changed("environments", `id <> '${ids.sandbox}'`)).toEqual([
    { created: T1.getTime(), updated: T1.getTime() },
  ]);
  // Rows that never change keep their created, and have no updated.
  for (const table of [
    "events",
    "event_entities",
    "sessions",
    "invites",
    "case_evidence",
    "case_items",
    "model_artifacts",
  ]) {
    for (const row of await times(table)) expect(row, table).toEqual({ created: T1.getTime() });
  }
});
