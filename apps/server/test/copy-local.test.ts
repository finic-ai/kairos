import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { decodeTime } from "ulid";
import { describe, expect, inject, it } from "vitest";
import type { Database } from "../src/platform/database";
import { copyLocal, slugsOf, type Source } from "../scripts/copy-local";
import { testDatabase } from "./helpers/database";

const LEGACY = fileURLToPath(new URL("./fixtures/legacy-migrations", import.meta.url));

/** A database with the migrations from before the restart, up to and with `last`. */
async function legacyDatabase(last: number): Promise<{ db: Database; source: Source }> {
  const folder = mkdtempSync(join(tmpdir(), "kairos-legacy-"));
  // One folder for each migration, in order: 0 is the first.
  for (const migration of readdirSync(LEGACY)
    .sort()
    .slice(0, last + 1))
    cpSync(join(LEGACY, migration), join(folder, migration), { recursive: true });
  const { db } = await testDatabase(folder);
  const [{ name }] = (await db.execute<Record<string, any>>(sql`SELECT current_database() AS name`)).rows as [
    { name: string },
  ];
  const url = new URL(inject("postgresUrl"));
  return {
    db,
    source: {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: name,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    },
  };
}

const rows = async <T = Record<string, unknown>>(db: Database, query: string) =>
  (await db.execute<Record<string, any>>(sql.raw(query))).rows as T[];
const at = (minute: number) => `2026-03-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const iso = (value: unknown) => new Date(value as string).toISOString();

/** Rows in the old schema for each rule of the copy. */
async function fill(db: Database) {
  await db.execute<Record<string, any>>(
    sql.raw(`
    INSERT INTO workspaces (id, name, created) VALUES ('ws_a', 'Acme Payments', '${at(1)}'), ('ws_b', 'acme  payments!', '${at(2)}'), ('ws_c', '!!!', '${at(3)}');
    INSERT INTO environments (id, workspace_id, name, kind, created) VALUES ('env_a', 'ws_a', 'Production', 'production', '${at(1)}'), ('env_b', 'ws_b', 'Production', 'production', '${at(2)}'), ('env_c', 'ws_c', 'Production', 'production', '${at(3)}'),
      ('env_s', 'ws_a', 'Sandbox', 'sandbox', '${at(16)}');
    INSERT INTO users (id, email, name, password_hash, supabase_id, created) VALUES
      ('usr_native', 'ada@example.com', 'Ada', 'hash-1', NULL, '${at(1)}'),
      ('usr_supabase', 'ben@example.com', 'Ben', NULL, 'sb_1', '${at(2)}'),
      ('usr_linked', 'cy@example.com', 'Cy', 'hash-2', 'sb_2', '${at(3)}');
    INSERT INTO memberships (workspace_id, user_id, role, created) VALUES ('ws_a', 'usr_native', 'owner', '${at(1)}'), ('ws_a', 'usr_supabase', 'member', '${at(2)}');
    INSERT INTO sessions (token_hash, user_id, created, expires) VALUES ('t1', 'usr_native', '${at(4)}', '2026-04-01T00:00:00Z'), ('t2', 'usr_native', '${at(6)}', '2026-04-01T00:00:00Z');
    INSERT INTO events (workspace_id, environment_id, id, type, ts, entities, properties, received) VALUES
      ('ws_a', 'env_a', 'e1', 'login', '${at(5)}', '{"user":"u1"}', '{"b":1,"a":2}', '${at(7)}'),
      ('ws_a', 'env_a', 'e2', 'login', '${at(8)}', '{"user":"u1"}', '{}', NULL);
    INSERT INTO event_entities (workspace_id, environment_id, entity_type, entity_id, ts, event_id) VALUES ('ws_a', 'env_a', 'user', 'u1', '${at(5)}', 'e1'), ('ws_a', 'env_a', 'user', 'u1', '${at(8)}', 'e2');
    INSERT INTO objects (workspace_id, environment_id, type, id, properties, first_seen, updated) VALUES ('ws_a', 'env_a', 'user', 'u1', '{"z":1,"y":2}', '${at(5)}', '${at(8)}');
    INSERT INTO labels (workspace_id, environment_id, entity_type, entity_id, label, ts, properties) VALUES ('ws_a', 'env_a', 'user', 'u1', 'fraud', '${at(9)}', '{}');
    INSERT INTO decisions (workspace_id, environment_id, id, ts, action, subject_type, subject_id, decision, context, raw, resolution) VALUES
      ('ws_a', 'env_a', 'kdec_1', '${at(10)}', 'hold@1', 'user', 'u1', '{"decision":"block"}', '{"q":1,"p":2}', '{}', '{"outcome":"approve","by":"ada","at":"${at(20)}"}'),
      ('ws_a', 'env_a', 'kdec_2', '${at(11)}', 'hold@1', 'user', 'u1', '{"decision":"approve"}', '{}', '{}', NULL),
      ('ws_a', 'env_s', 'kdec_2', '${at(11)}', 'hold@1', 'user', 'u1', '{"decision":"approve"}', '{}', '{}', NULL);
    UPDATE decisions SET event_id = 'e1' WHERE id = 'kdec_1';
    INSERT INTO dashboards (workspace_id, environment_id, id, definition, created, updated) VALUES ('ws_a', 'env_a', 'dash_1', '{}', '${at(1)}', '${at(2)}'), ('ws_a', 'env_s', 'dash_1', '{}', '${at(17)}', '${at(17)}');
    INSERT INTO webhooks (id, workspace_id, environment_id, direction, name, enabled, secrets, url, config, created) VALUES
      ('wh_on', 'ws_a', 'env_a', 'out', 'On', true, '[]', 'https://example.com/a', '{}', '${at(1)}'),
      ('wh_off', 'ws_a', 'env_a', 'out', 'Off', false, '[]', 'https://example.com/b', '{}', '${at(1)}');
    INSERT INTO webhook_deliveries (id, workspace_id, environment_id, webhook_id, direction, status, attempts, next_attempt, created, finished) VALUES
      ('whd_1', 'ws_a', 'env_a', 'wh_on', 'out', 'pending', 2, '${at(30)}', '${at(12)}', NULL),
      ('whd_2', 'ws_a', 'env_a', 'wh_off', 'out', 'pending', 0, '${at(31)}', '${at(13)}', NULL),
      ('whd_3', 'ws_a', 'env_a', 'wh_on', 'out', 'delivered', 1, NULL, '${at(14)}', '${at(15)}');
  `),
  );
}

describe("copying the local database from before the migrations restarted", () => {
  it("gives each workspace a slug of its own, in the order they were made", () => {
    expect(
      slugsOf([
        { id: "a", name: "Acme" },
        { id: "b", name: "ACME" },
        { id: "c", name: "acme-2" },
        { id: "d", name: "" },
      ]),
    ).toEqual([
      { id: "a", slug: "acme" },
      { id: "b", slug: "acme-2" },
      { id: "c", slug: "acme-2-2" },
      { id: "d", slug: "workspace" },
    ]);
  });

  it("copies a database at migration 0007 and fills the new columns", async () => {
    const old = await legacyDatabase(7);
    await fill(old.db);
    const { db } = await testDatabase();
    const now = new Date("2026-10-25T12:00:00Z");
    const result = await copyLocal(db, old.source, now);

    // A table the old database does not have starts empty, except jobs: two are made below.
    for (const t of result.tables)
      expect([t.table, t.new]).toEqual([t.table, t.old === null ? (t.table === "jobs" ? 2 : 0) : t.old]);
    expect(result.tables.find((t) => t.table === "jobs")!.old).toBeNull();
    expect(result.dropped).toEqual([]);
    expect(result.linked).toEqual(["cy@example.com"]);
    expect(result.jobsMade).toBe(2);

    const users = await rows(
      db,
      "SELECT id, display_name, first_name, auth, password_hash, subject_id, status, settings, created, updated, last_login FROM users ORDER BY id",
    );
    expect(
      users.map(({ created, updated, last_login, ...u }) => ({
        ...u,
        updated: iso(updated) === iso(created),
        last_login: last_login && iso(last_login),
      })),
    ).toEqual([
      {
        id: "usr_linked",
        display_name: "Cy",
        first_name: null,
        auth: { provider: "supabase" },
        password_hash: null,
        subject_id: "sb_2",
        status: "active",
        settings: {},
        updated: true,
        last_login: null,
      },
      {
        id: "usr_native",
        display_name: "Ada",
        first_name: null,
        auth: { provider: "native", strategy: "email_password" },
        password_hash: "hash-1",
        subject_id: null,
        status: "active",
        settings: {},
        updated: true,
        last_login: at(6),
      },
      {
        id: "usr_supabase",
        display_name: "Ben",
        first_name: null,
        auth: { provider: "supabase" },
        password_hash: null,
        subject_id: "sb_1",
        status: "active",
        settings: {},
        updated: true,
        last_login: null,
      },
    ]);
    expect(await rows(db, "SELECT id, slug, status FROM workspaces ORDER BY id")).toEqual([
      { id: "ws_a", slug: "acme-payments", status: "active" },
      { id: "ws_b", slug: "acme-payments-2", status: "active" },
      { id: "ws_c", slug: "workspace", status: "active" },
    ]);
    expect(await rows(db, "SELECT status, permissions FROM memberships")).toEqual([
      { status: "active", permissions: {} },
      { status: "active", permissions: {} },
    ]);

    // json keeps its text; times come from the old columns.
    // Each event gets an id of its own, with the time it was received; the customer's id is external_id.
    const events = await rows<{ id: string; external_id: string; properties: string; created: string }>(
      db,
      "SELECT id, external_id, properties::text AS properties, created FROM events ORDER BY external_id",
    );
    expect(events.map((e) => [e.external_id, e.properties, iso(e.created)])).toEqual([
      ["e1", '{"b":1,"a":2}', at(7)],
      ["e2", "{}", at(8)],
    ]);
    for (const e of events) expect(e.id).toMatch(/^evt_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(events.map((e) => decodeTime(e.id.slice(4).toUpperCase()))).toEqual([Date.parse(at(7)), Date.parse(at(8))]);
    expect(
      (
        await rows(
          db,
          "SELECT e.external_id, x.created FROM event_entities x JOIN events e ON e.id = x.event_id ORDER BY 1",
        )
      ).map((x) => [x.external_id, iso(x.created)]),
    ).toEqual([
      ["e1", at(7)],
      ["e2", at(8)],
    ]);
    expect(await rows(db, "SELECT d.id, e.external_id FROM decisions d JOIN events e ON e.id = d.event_id")).toEqual([
      { id: "kdec_1", external_id: "e1" },
    ]);
    const objects = await rows(db, "SELECT id, external_id, properties::text AS p, created, updated FROM objects");
    expect(objects.map((o) => [o.external_id, o.p, iso(o.created), iso(o.updated)])).toEqual([
      ["u1", '{"z":1,"y":2}', at(5), at(8)],
    ]);
    expect(objects[0]!.id).toMatch(/^obj_/);
    for (const table of ["labels", "entities", "actions", "memberships", "sessions"]) {
      for (const r of await rows<{ id: string }>(db, `SELECT id FROM ${table}`))
        expect(r.id).toMatch(/^(lbl|ent|act|mem|ses)_[0-9a-hjkmnp-tv-z]{26}$/);
    }
    // An old sandbox copy reused the ids of its source: the production rows keep them.
    const ids = async (table: string) =>
      (
        await rows<{ environment_id: string; id: string }>(
          db,
          `SELECT environment_id, id FROM ${table} ORDER BY environment_id, id`,
        )
      ).map((r) => `${r.environment_id} ${r.id}`);
    expect(await ids("decisions")).toEqual([
      "env_a kdec_1",
      "env_a kdec_2",
      expect.stringMatching(/^env_s kdec_[0-9a-hjkmnp-tv-z]{26}$/),
    ]);
    expect(await ids("dashboards")).toEqual([
      "env_a dash_1",
      expect.stringMatching(/^env_s dash_[0-9a-hjkmnp-tv-z]{26}$/),
    ]);
    expect(
      (await rows(db, "SELECT created, updated FROM labels")).map((l) => [iso(l.created), iso(l.updated)]),
    ).toEqual([[at(9), at(9)]]);
    expect(
      (
        await rows(
          db,
          "SELECT id, context::text AS context, final_outcome, created, updated FROM decisions WHERE environment_id = 'env_a' ORDER BY id",
        )
      ).map((d) => [d.id, d.context, d.final_outcome, iso(d.created), iso(d.updated)]),
    ).toEqual([
      ["kdec_1", '{"q":1,"p":2}', "approve", at(10), at(20)],
      ["kdec_2", "{}", "approve", at(11), at(11)],
    ]);
    expect(
      (await rows(db, "SELECT id, updated FROM webhook_deliveries ORDER BY id")).map((d) => [d.id, iso(d.updated)]),
    ).toEqual([
      ["whd_1", at(12)],
      ["whd_2", at(13)],
      ["whd_3", at(15)],
    ]);
    expect((await rows(db, "SELECT updated FROM environments WHERE id = 'env_a'")).map((e) => iso(e.updated))).toEqual([
      at(1),
    ]);

    // Each delivery that was waiting has its job: paused while its endpoint is disabled.
    const jobs = await rows(
      db,
      "SELECT id, kind, key, group_key, payload, status, attempts, run_at, created FROM jobs ORDER BY key",
    );
    expect(
      jobs.map((j) => ({ ...j, id: String(j.id).slice(0, 4), run_at: iso(j.run_at), created: iso(j.created) })),
    ).toEqual([
      {
        id: "job_",
        kind: "webhook.deliver",
        key: "whd_1",
        group_key: "wh_on",
        payload: { delivery_id: "whd_1" },
        status: "pending",
        attempts: 2,
        run_at: at(30),
        created: at(12),
      },
      {
        id: "job_",
        kind: "webhook.deliver",
        key: "whd_2",
        group_key: "wh_off",
        payload: { delivery_id: "whd_2" },
        status: "paused",
        attempts: 0,
        run_at: at(31),
        created: at(13),
      },
    ]);

    // The order of members goes on after the copied ones.
    const [before] = await rows<{ seq: string }>(db, "SELECT max(seq) AS seq FROM memberships");
    await db.execute<Record<string, any>>(
      sql`INSERT INTO memberships (id, workspace_id, user_id, role) VALUES ('mem_new', 'ws_b', 'usr_native', 'owner')`,
    );
    const [after] = await rows<{ seq: string }>(db, "SELECT seq FROM memberships WHERE workspace_id = 'ws_b'");
    expect(Number(after!.seq)).toBeGreaterThan(Number(before!.seq));

    // Nothing of the old database is left in the new one, and the old one is as it was.
    expect(await rows(db, "SELECT nspname FROM pg_namespace WHERE nspname = 'kairos_old'")).toEqual([]);
    expect(await rows(db, "SELECT srvname FROM pg_foreign_server")).toEqual([]);
    expect(await rows(old.db, "SELECT name, password_hash, supabase_id FROM users WHERE id = 'usr_linked'")).toEqual([
      { name: "Cy", password_hash: "hash-2", supabase_id: "sb_2" },
    ]);

    await expect(copyLocal(db, old.source, now)).rejects.toThrow(/not empty/);
  });

  it("copies the jobs of a database at migration 0009 as they are", async () => {
    const old = await legacyDatabase(9);
    await fill(old.db);
    await old.db.execute<Record<string, any>>(
      sql.raw(`INSERT INTO jobs (id, kind, key, workspace_id, environment_id, group_key, payload, status, run_at, attempts, created, updated)
      VALUES ('job_old', 'webhook.deliver', 'whd_1', 'ws_a', 'env_a', 'wh_on', '{"delivery_id":"whd_1"}', 'pending', '${at(30)}', 2, '${at(12)}', '${at(12)}')`),
    );
    const { db } = await testDatabase();
    const result = await copyLocal(db, old.source);
    expect(result.jobsMade).toBe(0);
    expect(result.tables.find((t) => t.table === "jobs")).toEqual({ table: "jobs", old: 1, new: 1 });
    expect(await rows(db, "SELECT id, key, status FROM jobs")).toEqual([
      { id: "job_old", key: "whd_1", status: "pending" },
    ]);
  });

  it("refuses a database from before migration 0007, and leaves the new one empty", async () => {
    const old = await legacyDatabase(6);
    const { db } = await testDatabase();
    await expect(copyLocal(db, old.source)).rejects.toThrow(/before migration 0007/);
    expect(await rows(db, "SELECT count(*)::int AS n FROM workspaces")).toEqual([{ n: 0 }]);
    expect(await rows(db, "SELECT srvname FROM pg_foreign_server")).toEqual([]);
  });
});
