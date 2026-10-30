import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { caseJobs } from "../src/modules/cases/service";
import { runRetention } from "../src/modules/retention";
import { createJobs } from "../src/platform/jobs/worker";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { ApiKeysService } from "../src/services/api_key.service";
import { EnvironmentsService } from "../src/services/environment.service";
import { SessionsService } from "../src/services/session.service";
import { UsersService } from "../src/services/user.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const accounts = tenancyRepository(database.db);
const repos = createRepositories(database.db);
const environmentRepo = environmentsRepository(database.db);
const NOW = new Date("2026-10-23T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

let app: ReturnType<typeof createApp>;
let workspace: string;
let other: string;
let cookie: string;
let memberCookie: string;
const keys: Record<"prod" | "sandbox" | "other", string> = { prod: "", sandbox: "", other: "" };

const call = async (method: string, path: string, body?: unknown, auth: { key?: string; cookie?: string } = {}) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth.key ? { Authorization: `Bearer ${auth.key}` } : { Cookie: auth.cookie ?? cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

const count = async (table: string, where = sql`TRUE`) =>
  Number(
    (await database.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM ${sql.raw(table)} WHERE ${where}`)).rows[0]!
      .n,
  );
const inWorkspace = (id: string) => sql`workspace_id = ${id}`;

/** Old and new history for one user, through the API, in the key's environment. */
async function history(key: string, prefix: string) {
  const event = (id: string, ts: string, user: string) => ({
    id: `${prefix}-${id}`,
    type: "payment",
    ts,
    entities: { user, device: `${prefix}-device-${user}` },
    properties: { usd: 10 },
    // A property makes the entity's own row (objects); a name alone lives in event_entities.
    set: { user: { tier: "gold" } },
    universal_id: `${prefix}-record-${id}`,
    session: `${prefix}-session-${id}`,
  });
  expect(
    (
      await call(
        "POST",
        "/v1/events",
        {
          batch: [event("old", daysAgo(400), `${prefix}-old-user`), event("new", daysAgo(1), `${prefix}-new-user`)],
        },
        { key },
      )
    ).status,
  ).toBe(202);
  await call(
    "POST",
    "/v1/labels",
    {
      batch: [
        { entity: { type: "user", id: `${prefix}-old-user` }, label: "chargeback", ts: daysAgo(400) },
        { entity: { type: "user", id: `${prefix}-new-user` }, label: "chargeback", ts: daysAgo(1) },
      ],
    },
    { key },
  );
  await call("PUT", "/v1/actions/payment", { subject: "user", hold: "Should this payment be held?" }, { key });
  const old = await call(
    "POST",
    "/v1/decide",
    { action: "payment", entities: { user: `${prefix}-old-user` } },
    { key },
  );
  await call("POST", "/v1/decide", { action: "payment", entities: { user: `${prefix}-new-user` } }, { key });
  // A decision is made now; this one is made old, as if it had been decided 400 days ago.
  await database.db.execute(sql`UPDATE decisions SET ts = ${daysAgo(400)} WHERE id = ${old.body.decision_id}`);
  // Entities were last changed when their events arrived; the old user's long ago.
  await database.db.execute(
    sql`UPDATE objects SET updated = ${daysAgo(400)}, first_seen = ${daysAgo(400)} WHERE external_id LIKE ${`${prefix}-old-%`} OR external_id LIKE ${`${prefix}-device-${prefix}-old-%`}`,
  );
}

beforeEach(async () => {
  await database.reset();
  const users = new UsersService(database.db);
  const sessions = new SessionsService(database.db);
  const newUser = (email: string) =>
    users.createWithAuth(
      { email, displayName: email, auth: { provider: "native", strategy: "email_password" }, passwordHash: "x" },
      NOW,
    );
  const owner = await newUser("owner@example.com");
  workspace = (await accounts.createWorkspace("Acme", owner.id, NOW)).id;
  other = (await accounts.createWorkspace("Other", owner.id, NOW)).id;
  cookie = `kairos_session=${(await sessions.start(owner.id, NOW)).token}`;
  const member = await newUser("member@example.com");
  await database.db.execute(
    sql`INSERT INTO memberships (id, workspace_id, user_id, role, status, created, updated)
        VALUES ('mem_test', ${workspace}, ${member.id}, 'member', 'active', ${NOW}, ${NOW})`,
  );
  memberCookie = `kairos_session=${(await sessions.start(member.id, NOW)).token}`;

  const production = (id: string) => new EnvironmentsService(database.db, { workspaceId: id }).findByIdOrProduction();
  const sandbox = (await environmentRepo.createSandbox(workspace, { name: "Development" }, owner.id, NOW))!;
  const key = async (workspaceId: string, environmentId: string) =>
    (
      await new ApiKeysService(database.db, { workspaceId }).createWithSecret(
        { environmentId, name: "k", kind: "secret", allowedIps: [], allowedOrigins: [], createdBy: owner.id },
        NOW,
      )
    ).secret;
  keys.prod = await key(workspace, (await production(workspace))!.id);
  keys.sandbox = await key(workspace, sandbox.id);
  keys.other = await key(other, (await production(other))!.id);

  app = createApp({
    accounts,
    environments: environmentRepo,
    repos,
    decider: async () => ({
      id: "d",
      model: "test",
      answers: { hold: { type: "noul" as const, value: false, probability: 0.1 } },
      usage: { input_tokens: 1 },
    }),
    now: () => NOW,
  });
});

/** An open case in production about a new decision for `user`, through a queue. */
async function openCase(user: string) {
  const runner = createJobs({
    repo: repos.jobs,
    kinds: caseJobs({ repos, now: () => NOW }).kinds,
    now: () => NOW,
    random: () => 0.5,
    log: () => {},
  });
  const queue = await call(
    "POST",
    "/v1/queues",
    {
      name: "Every payment",
      visibility: "workspace",
      sources: { actions: ["payment"] },
      intake: [
        {
          id: "all",
          name: "All",
          priority: "normal",
          conditions: { any: [{ field: "decision.outcome", op: "in", value: ["approve", "review", "block"] }] },
        },
      ],
      correlation: { by: "subject", window_days: 30 },
    },
    { key: keys.prod },
  );
  expect(queue.status, JSON.stringify(queue.body)).toBe(200);
  const decision = await call(
    "POST",
    "/v1/decide",
    { action: "payment", entities: { user } },
    {
      key: keys.prod,
    },
  );
  await runner.drain();
  const [item] = await database.db
    .execute<{ case_id: string }>(
      sql`SELECT case_id FROM case_items WHERE kind = 'decision' AND ref_id = ${decision.body.decision_id}`,
    )
    .then((r) => r.rows);
  expect(item).toBeDefined();
  return { caseId: item!.case_id, decisionId: decision.body.decision_id as string };
}

describe("the setting", () => {
  it("keeps data forever by default, and admins change it", async () => {
    expect((await call("GET", `/app/workspaces/${workspace}/data-retention`)).body).toEqual({ retention_days: null });
    const set = await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    expect(set).toEqual({ status: 200, body: { retention_days: 90 } });
    expect((await call("GET", `/app/workspaces/${workspace}/data-retention`)).body).toEqual({ retention_days: 90 });
    const settings = await database.db.execute<{ settings: Record<string, unknown> }>(
      sql`SELECT settings FROM workspaces WHERE id = ${workspace}`,
    );
    expect(settings.rows[0]!.settings).toMatchObject({ data_retention_days: 90 });

    // Back to forever: the key goes from the settings.
    expect((await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: null })).body).toEqual({
      retention_days: null,
    });
    const after = await database.db.execute<{ settings: Record<string, unknown> }>(
      sql`SELECT settings FROM workspaces WHERE id = ${workspace}`,
    );
    expect(after.rows[0]!.settings).not.toHaveProperty("data_retention_days");
  });

  it("accepts 7 days to 10 years, in whole days", async () => {
    for (const bad of [0, 6, 3651, 30.5, "90", -1])
      expect((await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: bad })).status).toBe(
        400,
      );
    expect((await call("PUT", `/app/workspaces/${workspace}/data-retention`, {})).status).toBe(400);
    for (const good of [7, 3650])
      expect((await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: good })).status).toBe(
        200,
      );
  });

  it("lets members read it, and only admins change it", async () => {
    expect(
      (await call("GET", `/app/workspaces/${workspace}/data-retention`, undefined, { cookie: memberCookie })).status,
    ).toBe(200);
    expect(
      (
        await call(
          "PUT",
          `/app/workspaces/${workspace}/data-retention`,
          { retention_days: 30 },
          { cookie: memberCookie },
        )
      ).status,
    ).toBe(403);
  });
});

describe("the cleanup", () => {
  beforeEach(async () => {
    await history(keys.prod, "prod");
    await history(keys.sandbox, "sbx");
    await history(keys.other, "oth");
  });

  it("deletes nothing while the workspace keeps data forever", async () => {
    const before = await Promise.all(["events", "decisions", "labels", "objects"].map((t) => count(t)));
    expect(await runRetention(database.db, NOW)).toEqual([]);
    expect(await Promise.all(["events", "decisions", "labels", "objects"].map((t) => count(t)))).toEqual(before);
  });

  it("deletes the history older than the period in every environment of the workspace, and keeps the rest", async () => {
    await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    const [run] = await runRetention(database.db, NOW);
    expect(run).toMatchObject({ workspace, purged: { events: 2, decisions: 2, labels: 2, complete: true } });

    for (const prefix of ["prod", "sbx"]) {
      expect(await count("events", sql`external_id LIKE ${`${prefix}-%`}`)).toBe(1);
      expect(await count("events", sql`external_id = ${`${prefix}-new`}`)).toBe(1);
      expect(await count("labels", sql`entity_id = ${`${prefix}-old-user`}`)).toBe(0);
      expect(await count("labels", sql`entity_id = ${`${prefix}-new-user`}`)).toBe(1);
      expect(await count("decisions", sql`subject_id = ${`${prefix}-old-user`}`)).toBe(0);
      expect(await count("decisions", sql`subject_id = ${`${prefix}-new-user`}`)).toBe(1);
      // The old user: nothing names them any more, so their row and properties go.
      expect(await count("objects", sql`external_id = ${`${prefix}-old-user`}`)).toBe(0);
      expect(await count("objects", sql`external_id = ${`${prefix}-new-user`}`)).toBe(1);
      // The old event's entity links went with it.
      expect(await count("event_entities", sql`entity_id = ${`${prefix}-old-user`}`)).toBe(0);
    }
  });

  it("leaves another workspace alone", async () => {
    await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    const before = await Promise.all(
      ["events", "decisions", "labels", "objects"].map((t) => count(t, inWorkspace(other))),
    );
    await runRetention(database.db, NOW);
    expect(
      await Promise.all(["events", "decisions", "labels", "objects"].map((t) => count(t, inWorkspace(other)))),
    ).toEqual(before);
    expect(await count("events", sql`external_id = 'oth-old'`)).toBe(1);
  });

  it("keeps an entity that something recent still names", async () => {
    await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    // The old user comes back today.
    await call(
      "POST",
      "/v1/events",
      { batch: [{ id: "prod-again", type: "login", ts: daysAgo(0), entities: { user: "prod-old-user" } }] },
      { key: keys.prod },
    );
    await database.db.execute(sql`UPDATE objects SET updated = ${daysAgo(400)} WHERE external_id = 'prod-old-user'`);
    await runRetention(database.db, NOW);
    expect(await count("objects", sql`external_id = 'prod-old-user'`)).toBe(1);
    expect(await count("events", sql`external_id = 'prod-again'`)).toBe(1);
    // Their old chargeback stays while they are active, so workflows still see it.
    expect(await count("labels", sql`entity_id = 'prod-old-user'`)).toBe(1);
    expect(await count("labels", sql`entity_id = 'sbx-old-user'`)).toBe(0);
  });

  it("keeps an open case however old, and deletes a resolved one", async () => {
    const { caseId } = await openCase("prod-new-user");
    await database.db.execute(sql`UPDATE cases SET last_activity = ${daysAgo(400)} WHERE id = ${caseId}`);
    await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    await runRetention(database.db, NOW);
    expect(await count("cases", sql`id = ${caseId}`)).toBe(1);

    await database.db.execute(
      sql`UPDATE cases SET status = 'resolved', resolved_at = ${daysAgo(400)} WHERE id = ${caseId}`,
    );
    await runRetention(database.db, NOW);
    expect(await count("cases", sql`id = ${caseId}`)).toBe(0);
  });

  it("starts with a different workspace each hour", async () => {
    await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    await database.db.execute(
      sql`UPDATE workspaces SET settings = settings || '{"data_retention_days": 90}'::jsonb WHERE id = ${other}`,
    );
    const order = async (at: Date) => (await runRetention(database.db, at)).map((r) => r.workspace);
    const first = await order(NOW);
    const next = await order(new Date(NOW.getTime() + 3_600_000));
    expect(first).toHaveLength(2);
    expect(next).toEqual([...first].reverse());
  });

  it("keeps a case's items whose event or decision is kept, and takes those whose is gone", async () => {
    const { caseId, decisionId } = await openCase("prod-new-user");
    // Items for the event kept (prod-new) and the event deleted (prod-old), by the event's external id.
    for (const [id, ref] of [
      ["item_new", "prod-new"],
      ["item_old", "prod-old"],
    ])
      await database.db
        .execute(sql`INSERT INTO case_items (id, workspace_id, environment_id, case_id, kind, ref_id, evidence_id, created)
        SELECT ${id}, workspace_id, environment_id, case_id, 'event', ${ref}, evidence_id, created
          FROM case_items WHERE kind = 'decision' AND ref_id = ${decisionId}`);

    await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    const [run] = await runRetention(database.db, NOW);
    expect(run!.purged.case_items).toBe(1);
    expect(
      await database.db
        .execute<{ kind: string; ref_id: string }>(
          sql`SELECT kind, ref_id FROM case_items WHERE case_id = ${caseId} AND kind IN ('event', 'decision') ORDER BY kind, ref_id`,
        )
        .then((r) => r.rows),
    ).toEqual([
      { kind: "decision", ref_id: decisionId },
      { kind: "event", ref_id: "prod-new" },
    ]);
  });

  it("can run again, and goes on after a run that ran out of time", async () => {
    await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    // A run with no time left deletes nothing and says it is not done.
    const [stopped] = await runRetention(database.db, NOW, -1);
    expect(stopped!.purged).toMatchObject({ events: 0, complete: false });
    const [done] = await runRetention(database.db, NOW);
    expect(done!.purged).toMatchObject({ events: 2, complete: true });
    const [again] = await runRetention(database.db, NOW);
    expect(again!.purged).toEqual({
      cases: 0,
      decisions: 0,
      events: 0,
      labels: 0,
      webhook_deliveries: 0,
      workflow_runs: 0,
      case_items: 0,
      entities: 0,
      complete: true,
    });
  });

  it("deletes in batches", async () => {
    await call("PUT", `/app/workspaces/${workspace}/data-retention`, { retention_days: 90 });
    for (let b = 0; b < 5; b++)
      await call(
        "POST",
        "/v1/events",
        {
          batch: Array.from({ length: 500 }, (_, i) => ({
            id: `bulk-${b}-${i}`,
            type: "page_view",
            ts: daysAgo(200),
            entities: { device: "bulk-device" },
          })),
        },
        { key: keys.prod },
      );
    const [run] = await runRetention(database.db, NOW);
    // 2,500 bulk events (three batches of up to 1,000) and the two old payments.
    expect(run!.purged.events).toBe(2502);
    expect(await count("events", sql`external_id LIKE 'bulk-%'`)).toBe(0);
  });
});
