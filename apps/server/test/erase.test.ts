import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { apiKeys } from "../src/db/schema";
import { caseJobs } from "../src/modules/cases/service";
import { createJobs } from "../src/platform/jobs/worker";
import { hashToken } from "../src/platform/crypto";
import { SessionsService } from "../src/services/session.service";
import { UsersService } from "../src/services/user.service";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const NOW = new Date("2026-10-06T14:00:00Z");
const database = await testDatabase();
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => ({
      id: "dec_1",
      model: "grayson-1",
      answers: { hold: { type: "noul", value: false, probability: 0.04 } },
      usage: { input_tokens: 1 },
    }),
    now: () => NOW,
  });
});

const call = (method: string, path: string, body?: unknown, key = "key_a") =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const rows = async (query: ReturnType<typeof sql>) => (await database.db.execute<Record<string, any>>(query)).rows;

/** Ada (u1) and Ben (u2) share a device; Ada's email is in her events and on her entity. */
async function seed(key = "key_a") {
  await call(
    "PUT",
    "/v1/actions/withdrawal",
    { subject: "user", hold: "Should this withdrawal be held because the account shows signs of fraud?" },
    key,
  );
  await call(
    "POST",
    "/v1/events",
    {
      batch: [
        {
          id: "e1",
          type: "login",
          ts: "2026-10-05T10:00:00Z",
          entities: { user: "u1", device: "d1" },
          properties: { email: "ada@example.com" },
          set: { user: { name: "Ada Lovelace", email: "ada@example.com" } },
        },
        {
          id: "e2",
          type: "withdrawal",
          ts: "2026-10-05T11:00:00Z",
          entities: { user: "u1" },
          properties: { usd: 900 },
          universal_id: "w1",
          status: "pending",
        },
        { id: "e3", type: "login", ts: "2026-10-05T12:00:00Z", entities: { user: "u2", device: "d1" } },
      ],
    },
    key,
  );
  await call("POST", "/v1/labels", { batch: [{ entity: { type: "user", id: "u1" }, label: "fraud_confirmed" }] }, key);
  const ada = await (await call("POST", "/v1/decide", { action: "withdrawal", entities: { user: "u1" } }, key)).json();
  // Ben's decision names Ada's device, so the model saw Ada through it.
  const ben = await (
    await call("POST", "/v1/decide", { action: "withdrawal", entities: { user: "u2", device: "d1" } }, key)
  ).json();
  return { ada: ada.decision_id as string, ben: ben.decision_id as string };
}

describe("DELETE /v1/entities/:type/:id", () => {
  it("erases the entity, its labels, its own events and the decisions about it", async () => {
    const { ada, ben } = await seed();
    // A decision about the device, with Ada in its request: the model read Ada's events and email.
    await call("PUT", "/v1/actions/device_check", { subject: "device", hold: "Should this device be blocked?" });
    const device = (
      await (
        await call("POST", "/v1/decide", { action: "device_check", entities: { device: "d1", user: "u1" } })
      ).json()
    ).decision_id as string;
    const response = await call("DELETE", "/v1/entities/user/u1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      entity: { type: "user", id: "u1" },
      dry_run: false,
      erased: { entity: 1, labels: 1, events: 1, events_redacted: 1, decisions: 1 },
    });

    expect((await call("GET", "/v1/entities/user/u1")).status).toBe(404);
    expect((await call("GET", `/v1/decisions/${ada}`)).status).toBe(404);
    // The login also named the device, so it stays for the device, without Ada and without its properties.
    expect(await rows(sql`SELECT external_id, entities, properties FROM events ORDER BY external_id`)).toEqual([
      { external_id: "e1", entities: { device: "d1" }, properties: {} },
      { external_id: "e3", entities: { user: "u2", device: "d1" }, properties: {} },
    ]);
    expect(await rows(sql`SELECT * FROM labels`)).toEqual([]);
    expect(await rows(sql`SELECT entity_type, entity_id FROM event_entities WHERE entity_id = 'u1'`)).toEqual([]);
    // No copy of Ada's email anywhere it was stored.
    for (const table of ["events", "objects", "decisions"])
      expect(await rows(sql.raw(`SELECT 1 FROM ${table} WHERE ${table}::text LIKE '%ada@example.com%'`))).toEqual([]);

    // Ben and the shared device stay.
    expect((await call("GET", "/v1/entities/user/u2")).status).toBe(200);
    expect((await call("GET", "/v1/entities/device/d1")).status).toBe(200);
    const kept = await (await call("GET", `/v1/decisions/${ben}`)).json();
    expect(kept.decision).toBeDefined();
    // A linked subject's decision shows counts, never Ada herself: it stays as it was.
    expect(kept.context.subject).toEqual(expect.objectContaining({ id: "u2" }));
    // The device's decision named Ada: it stays, without what the model read.
    expect(body.erased.decisions_redacted).toBe(1);
    const redacted = await (await call("GET", `/v1/decisions/${device}`)).json();
    expect(redacted.decision).toBeDefined();
    expect(redacted.context).toEqual({ erased: true });
  });

  it("answers 404 for an entity Kairos holds nothing about, so a second erasure is a 404", async () => {
    await seed();
    expect((await call("DELETE", "/v1/entities/user/u1")).status).toBe(200);
    const again = await call("DELETE", "/v1/entities/user/u1");
    expect(again.status).toBe(404);
    expect((await again.json()).error.type).toBe("not_found");
    expect((await call("DELETE", "/v1/entities/user/nobody")).status).toBe(404);
  });

  it("counts with a dry run and deletes nothing", async () => {
    await seed();
    const dry = await (await call("DELETE", "/v1/entities/user/u1?dry_run=true")).json();
    expect(dry).toMatchObject({
      dry_run: true,
      erased: { entity: 1, labels: 1, events: 1, events_redacted: 1, decisions: 1 },
    });
    expect((await call("GET", "/v1/entities/user/u1")).status).toBe(200);
    expect(await rows(sql`SELECT count(*)::int AS n FROM events`)).toEqual([{ n: 3 }]);
    expect(await rows(sql`SELECT count(*)::int AS n FROM labels`)).toEqual([{ n: 1 }]);
  });

  it("erases only in the key's own workspace and environment", async () => {
    await seed("key_a");
    await seed("key_b");
    expect((await call("DELETE", "/v1/entities/user/u1", undefined, "key_b")).status).toBe(200);
    expect((await call("GET", "/v1/entities/user/u1", undefined, "key_b")).status).toBe(404);
    expect((await call("GET", "/v1/entities/user/u1", undefined, "key_a")).status).toBe(200);
    expect(await rows(sql`SELECT count(*)::int AS n FROM events WHERE workspace_id = 'workspace_a'`)).toEqual([
      { n: 3 },
    ]);
  });

  it("needs a secret key", async () => {
    await seed();
    await database.db.insert(apiKeys).values({
      id: "key_public",
      workspaceId: "workspace_a",
      environmentId: "workspace_a",
      name: "public",
      kind: "public",
      keyHash: hashToken("kpk_public"),
      hint: "blic",
      allowedIps: [],
      allowedOrigins: [],
      created: NOW,
      updated: NOW,
    });
    const response = await call("DELETE", "/v1/entities/user/u1", undefined, "kpk_public");
    expect(response.status).toBe(403);
    expect((await response.json()).error.type).toBe("public_key_scope");
    expect((await call("GET", "/v1/entities/user/u1")).status).toBe(200);
  });

  it("takes the cases about the erased entity, and its copies in other cases", async () => {
    const repos = createRepositories(database.db);
    const runner = createJobs({
      repo: repos.jobs,
      kinds: caseJobs({ repos, now: () => NOW }).kinds,
      now: () => NOW,
      random: () => 0.5,
      log: () => {},
    });
    await call("PUT", "/v1/actions/withdrawal", {
      subject: "user",
      hold: "Should this withdrawal be held because the account shows signs of fraud?",
    });
    const queue = await call("POST", "/v1/queues", {
      name: "Every withdrawal",
      visibility: "workspace",
      sources: { actions: ["withdrawal"] },
      intake: [
        {
          id: "all",
          name: "All",
          priority: "normal",
          conditions: { any: [{ field: "decision.outcome", op: "in", value: ["approve", "review", "block"] }] },
        },
      ],
      correlation: { by: "subject", window_days: 30 },
    });
    expect(queue.status, JSON.stringify(await queue.clone().json())).toBe(200);
    const { ada } = await seed();
    await runner.drain();
    expect(await rows(sql`SELECT target_id FROM cases ORDER BY target_id`)).toEqual([
      { target_id: "u1" },
      { target_id: "u2" },
    ]);

    const erased = (await (await call("DELETE", "/v1/entities/user/u1")).json()).erased;
    expect(erased).toMatchObject({ cases: 1, decisions: 1 });
    expect(await rows(sql`SELECT target_id FROM cases`)).toEqual([{ target_id: "u2" }]);
    expect(await rows(sql`SELECT 1 FROM case_items WHERE ref_id IN (${ada}, 'u1', 'e1', 'e2')`)).toEqual([]);
    expect(await rows(sql`SELECT 1 FROM case_evidence WHERE source_id = ${ada}`)).toEqual([]);
  });

  it("keeps other people's events and decisions when a shared entity is erased", async () => {
    const { ada, ben } = await seed();
    const body = await (await call("DELETE", "/v1/entities/device/d1")).json();
    expect(body.erased).toMatchObject({ events: 0, events_redacted: 2, decisions: 0 });
    expect(await rows(sql`SELECT external_id, entities FROM events ORDER BY external_id`)).toEqual([
      { external_id: "e1", entities: { user: "u1" } },
      { external_id: "e2", entities: { user: "u1" } },
      { external_id: "e3", entities: { user: "u2" } },
    ]);
    expect(await rows(sql`SELECT 1 FROM event_entities WHERE entity_type = 'device'`)).toEqual([]);
    // Both decisions are still there, without what the model read about the device.
    for (const decision of [ada, ben]) {
      const kept = await (await call("GET", `/v1/decisions/${decision}`)).json();
      expect(kept.decision).toBeDefined();
      expect(kept.context).toEqual({ erased: true });
    }
  });

  it("redacts only the decisions that name the entity, not those with its id as some other value", async () => {
    await seed();
    await call("PUT", "/v1/actions/note", { subject: "user", hold: "Should this be held?" });
    const unrelated = (
      await (
        await call("POST", "/v1/decide", { action: "note", entities: { user: "u2" }, properties: { ref: "u1" } })
      ).json()
    ).decision_id as string;
    const body = await (await call("DELETE", "/v1/entities/user/u1")).json();
    expect(body.erased.decisions_redacted).toBe(0);
    const kept = await (await call("GET", `/v1/decisions/${unrelated}`)).json();
    expect(kept.context).not.toEqual({ erased: true });
  });

  it("erases an entity that only someone else's decision named, and does not answer 404 for it", async () => {
    await seed();
    const decision = (
      await (
        await call("POST", "/v1/decide", { action: "withdrawal", entities: { user: "u2", email: "ada@example.com" } })
      ).json()
    ).decision_id as string;
    const response = await call("DELETE", "/v1/entities/email/ada@example.com");
    expect(response.status).toBe(200);
    // Ben's decision named the address; Ada's read it in her login event.
    expect((await response.json()).erased).toMatchObject({ entity: 0, events: 0, decisions_redacted: 2 });
    expect((await (await call("GET", `/v1/decisions/${decision}`)).json()).context).toEqual({ erased: true });
  });

  it("deletes the runs of its decisions and redacts the finished runs that named it", async () => {
    const { ada } = await seed();
    const run = (id: string, key: string, status: string, trigger: unknown) =>
      database.db
        .execute(sql`INSERT INTO workflow_runs (id, workspace_id, environment_id, workflow, key, status, trigger, steps, output, created)
        VALUES (${id}, 'workspace_a', 'workspace_a', 'flow@1', ${key}, ${status}, ${JSON.stringify(trigger)}::jsonb,
          '[{"id":"read"}]'::jsonb, '{"ok":true}'::jsonb, ${NOW})`);
    await run("run_own", "decision:own", "done", { entities: { user: "u1" } });
    await database.db.execute(
      sql`UPDATE decisions SET metadata = metadata || '{"workflow_run_id":"run_own"}'::jsonb WHERE id = ${ada}`,
    );
    await run("run_event", "event:e1", "done", { event: { id: "e1", entities: { user: "u1", device: "d1" } } });
    await run("run_device", "decision:device", "done", { entities: { device: "d1", user: "u1" } });
    await run("run_open", "decision:open", "running", { entities: { device: "d1", user: "u1" } });
    await run("run_ben", "decision:ben", "done", { entities: { user: "u2" }, properties: { ref: "u1" } });

    const body = await (await call("DELETE", "/v1/entities/user/u1")).json();
    expect(body.erased).toMatchObject({ workflow_runs: 1, workflow_runs_redacted: 2 });
    const erased = { trigger: { erased: true }, steps: null, output: null };
    const kept = { steps: [{ id: "read" }], output: { ok: true } };
    expect(await rows(sql`SELECT id, trigger, steps, output FROM workflow_runs ORDER BY id`)).toEqual([
      { id: "run_ben", trigger: { entities: { user: "u2" }, properties: { ref: "u1" } }, ...kept },
      { id: "run_device", ...erased },
      { id: "run_event", ...erased },
      // Still going: it needs its trigger to finish.
      { id: "run_open", trigger: { entities: { device: "d1", user: "u1" } }, ...kept },
    ]);
  });

  it("lets a signed-in admin erase, and not a member", async () => {
    await seed();
    const users = new UsersService(database.db);
    const sessions = new SessionsService(database.db);
    const cookieFor = async (email: string, role: string) => {
      const user = await users.createWithAuth(
        { email, displayName: email, auth: { provider: "native", strategy: "email_password" }, passwordHash: "x" },
        NOW,
      );
      await database.db.execute(sql`INSERT INTO memberships (id, workspace_id, user_id, role, status, created, updated)
        VALUES (${`mem_${role}`}, 'workspace_a', ${user.id}, ${role}, 'active', ${NOW}, ${NOW})`);
      return `kairos_session=${(await sessions.start(user.id, NOW)).token}`;
    };
    const erase = async (cookie: string) =>
      app.request("/v1/entities/user/u1", {
        method: "DELETE",
        headers: { Cookie: cookie, "X-Kairos-Workspace": "workspace_a" },
      });

    const refused = await erase(await cookieFor("member@example.com", "member"));
    expect(refused.status).toBe(403);
    expect((await call("GET", "/v1/entities/user/u1")).status).toBe(200);
    expect((await erase(await cookieFor("admin@example.com", "admin"))).status).toBe(200);
  });
});
