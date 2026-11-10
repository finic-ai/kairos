import { generateKeyPairSync, sign } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashPassword, verifyPassword } from "../src/platform/crypto";
import { invalidIpRules, ipAllowed, normalizeOrigins, originAllowed } from "../src/platform/network";
import {
  tenancyRepository,
  createRepositories,
  environmentsRepository,
  type TenancyRepository,
} from "../src/repositories";
import { forgetKeys, type CognitoConfig } from "../src/platform/auth/cognito";
import { UsersService } from "../src/services/user.service";
import { WorkspacesService } from "../src/services/workspace.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();

const NOW = new Date("2026-10-10T12:00:00Z");
let app: ReturnType<typeof createApp>;
let accounts: TenancyRepository;
let clock: Date;

function build(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const repos = createRepositories(database.db);
  const environments = environmentsRepository(database.db);
  accounts = tenancyRepository(database.db);
  clock = NOW;
  app = createApp({
    repos,
    accounts,
    environments,
    decider: async () => ({
      id: "d",
      model: "grayson-1",
      answers: { hold: { type: "noul", value: false, probability: 0.1 } },
      usage: { input_tokens: 1 },
    }),
    now: () => clock,
    trustProxy: true,
    ...extra,
  });
}
beforeEach(async () => {
  await database.reset();
  build();
});

interface Options {
  cookie?: string;
  key?: string;
  workspace?: string;
  ip?: string;
}

const call = (method: string, path: string, body?: unknown, o: Options = {}) =>
  app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(o.cookie ? { Cookie: o.cookie } : {}),
      ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}),
      ...(o.workspace ? { "X-Kairos-Workspace": o.workspace } : {}),
      ...(o.ip ? { "X-Forwarded-For": o.ip } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Sign up and return the session cookie and the first workspace. */
async function signup(email: string, extra: Record<string, unknown> = {}) {
  const response = await call("POST", "/auth/signup", {
    email,
    password: "correct horse",
    name: email.split("@")[0],
    ...extra,
  });
  const data = await response.json();
  return {
    response,
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!,
    data,
    workspace: data.workspaces?.[0]?.id as string,
  };
}

const event = (id: string) => ({
  id,
  type: "login",
  ts: "2026-10-10T11:00:00Z",
  entities: { user: "u1" },
  properties: {},
});

describe("passwords and address rules", () => {
  it("verifies a password against its bcrypt hash, and nothing else", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
  });

  it("matches addresses and IPv4 ranges", () => {
    expect(ipAllowed("203.0.113.7", [])).toBe(true);
    expect(ipAllowed("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(ipAllowed("::ffff:203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(ipAllowed("203.0.113.200", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("203.0.114.1", ["203.0.113.0/24"])).toBe(false);
    expect(ipAllowed(undefined, ["203.0.113.0/24"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(invalidIpRules(["203.0.113.7", "10.0.0.0/8", "office", "10.0.0.0/40", "2001:db8::/32"])).toEqual([
      "office",
      "10.0.0.0/40",
      "2001:db8::/32",
    ]);
  });
});

describe("website rules", () => {
  it("reads website addresses as origins", () => {
    expect(
      normalizeOrigins([
        "Example.com",
        "https://app.example.com/",
        "http://localhost:3000",
        "https://*.example.com",
        "example.com",
      ]),
    ).toEqual({
      origins: ["https://example.com", "https://app.example.com", "http://localhost:3000", "https://*.example.com"],
      invalid: [],
    });
    expect(
      normalizeOrigins(["https://example.com/pricing", "ftp://example.com", "https://a.*.com", "*", "not a site"])
        .invalid,
    ).toHaveLength(5);
  });

  it("matches a website exactly, or by subdomain when the rule says so", () => {
    expect(originAllowed("https://anything.test", [])).toBe(true);
    expect(originAllowed("https://example.com", ["https://example.com"])).toBe(true);
    expect(originAllowed("http://example.com", ["https://example.com"])).toBe(false);
    expect(originAllowed("https://example.com.evil.test", ["https://example.com"])).toBe(false);
    expect(originAllowed(undefined, ["https://example.com"])).toBe(false);
    expect(originAllowed("https://app.example.com", ["https://*.example.com"])).toBe(true);
    expect(originAllowed("https://a.b.example.com", ["https://*.example.com"])).toBe(true);
    expect(originAllowed("https://example.com", ["https://*.example.com"])).toBe(false);
    expect(originAllowed("https://evilexample.com", ["https://*.example.com"])).toBe(false);
  });
});

describe("sign-up and sign-in", () => {
  it("creates an account with a workspace and a session that only the server can read", async () => {
    const { response, cookie, data } = await signup("ada@example.com");
    expect(response.status).toBe(200);
    expect(data.user).toMatchObject({ email: "ada@example.com", name: "ada" });
    expect(data.user).not.toHaveProperty("password_hash");
    expect(data.workspaces).toMatchObject([{ name: "ada's workspace", role: "owner" }]);
    expect(response.headers.get("set-cookie")).toMatch(/kairos_session=.+; .*HttpOnly; .*SameSite=Lax/);

    expect((await (await call("GET", "/auth/me", undefined, { cookie })).json()).user.email).toBe("ada@example.com");
    expect((await call("GET", "/auth/me")).status).toBe(401);
  });

  it("refuses a short password and a second account for one address", async () => {
    expect((await call("POST", "/auth/signup", { email: "ada@example.com", password: "short" })).status).toBe(400);
    expect((await call("POST", "/auth/signup", { email: "ada@example.com", password: "x".repeat(73) })).status).toBe(
      400,
    );
    await signup("ada@example.com");
    expect((await signup("ADA@example.com")).response.status).toBe(409);
  });

  it("signs in with the password, gives one answer for any failure, and signs out", async () => {
    await signup("ada@example.com");
    const wrong = await call("POST", "/auth/login", { email: "ada@example.com", password: "wrong horse" });
    const unknown = await call("POST", "/auth/login", { email: "nobody@example.com", password: "correct horse" });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(await wrong.json()).toEqual(await unknown.json());
    for (const password of ["", "correct horse" + "x".repeat(60)])
      expect((await call("POST", "/auth/login", { email: "ada@example.com", password })).status).toBe(400);

    const good = await call("POST", "/auth/login", { email: " Ada@Example.com ", password: "correct horse" });
    const cookie = good.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call("GET", "/auth/me", undefined, { cookie })).status).toBe(200);
    await call("POST", "/auth/logout", undefined, { cookie });
    expect((await call("GET", "/auth/me", undefined, { cookie })).status).toBe(401);
  });

  it("changes the name", async () => {
    const { cookie } = await signup("ada@example.com");
    const changed = await (await call("PATCH", "/auth/me", { name: " Ada Lovelace " }, { cookie })).json();
    expect(changed.user).toMatchObject({ name: "Ada Lovelace", has_password: true });
    expect((await (await call("GET", "/auth/me", undefined, { cookie })).json()).user.name).toBe("Ada Lovelace");
    expect((await call("PATCH", "/auth/me", { name: "" }, { cookie })).status).toBe(400);
    expect((await call("PATCH", "/auth/me", { name: "x" })).status).toBe(401);
  });

  it("changes the password only with the current one, and signs out the other devices", async () => {
    const { cookie } = await signup("ada@example.com");
    const other = (await call("POST", "/auth/login", { email: "ada@example.com", password: "correct horse" })).headers
      .get("set-cookie")!
      .split(";")[0]!;
    expect(
      (await call("POST", "/auth/password", { current: "wrong horse", password: "battery staple" }, { cookie })).status,
    ).toBe(403);
    expect(
      (await call("POST", "/auth/password", { current: "correct horse", password: "short" }, { cookie })).status,
    ).toBe(400);
    expect((await call("POST", "/auth/password", { password: "battery staple" }, { cookie })).status).toBe(400);
    expect(
      await (
        await call("POST", "/auth/password", { current: "correct horse", password: "battery staple" }, { cookie })
      ).json(),
    ).toEqual({ ok: true, sessions_ended: 1 });

    expect((await call("GET", "/auth/me", undefined, { cookie })).status).toBe(200);
    expect((await call("GET", "/auth/me", undefined, { cookie: other })).status).toBe(401);
    expect((await call("POST", "/auth/login", { email: "ada@example.com", password: "correct horse" })).status).toBe(
      401,
    );
    expect((await call("POST", "/auth/login", { email: "ada@example.com", password: "battery staple" })).status).toBe(
      200,
    );
  });

  it("ends a session after thirty days", async () => {
    const { cookie } = await signup("ada@example.com");
    clock = new Date(NOW.getTime() + 31 * 86_400_000);
    expect((await call("GET", "/auth/me", undefined, { cookie })).status).toBe(401);
  });

  it("gives the first account the workspaces that exist already, and no one after that", async () => {
    await accounts.ensureWorkspace("demo", "demo", NOW);
    const first = await signup("ada@example.com");
    expect(first.data.workspaces.map((w: any) => [w.id, w.role])).toEqual([["demo", "owner"]]);
    const second = await signup("ben@example.com");
    expect(second.data.workspaces.map((w: any) => w.name)).toEqual(["ben's workspace"]);
  });

  it("can be closed to everyone without an invite", async () => {
    build({ signup: false });
    await new UsersService(database.db).createWithAuth(
      {
        email: "owner@example.com",
        displayName: "owner",
        auth: { provider: "native", strategy: "email_password" },
        passwordHash: "x",
      },
      NOW,
    );
    expect((await signup("ada@example.com")).response.status).toBe(403);
    expect((await (await call("GET", "/auth/config")).json()).signup).toBe(false);
  });
});

describe("workspaces, members and invites", () => {
  it("keeps one workspace's data from the members of another", async () => {
    const ada = await signup("ada@example.com");
    const ben = await signup("ben@example.com");
    await call("POST", "/v1/events", { batch: [event("e1")] }, { cookie: ada.cookie, workspace: ada.workspace });

    expect(
      (await (await call("GET", "/v1/stats", undefined, { cookie: ada.cookie, workspace: ada.workspace })).json())
        .events,
    ).toBe(1);
    expect(
      (await (await call("GET", "/v1/stats", undefined, { cookie: ben.cookie, workspace: ben.workspace })).json())
        .events,
    ).toBe(0);
    expect((await call("GET", "/v1/stats", undefined, { cookie: ben.cookie, workspace: ada.workspace })).status).toBe(
      403,
    );
    expect((await call("GET", "/v1/stats", undefined, { cookie: ben.cookie })).status).toBe(400);
    expect((await call("GET", "/v1/stats", undefined, { workspace: ada.workspace })).status).toBe(401);
    expect(
      (await call("GET", `/app/workspaces/${ada.workspace}/members`, undefined, { cookie: ben.cookie })).status,
    ).toBe(404);
  });

  it("invites a person by a link that only their address can use", async () => {
    const ada = await signup("ada@example.com");
    const invited = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "Cy@example.com", role: "admin" },
        { cookie: ada.cookie },
      )
    ).json();
    expect(invited.invite).toMatchObject({ email: "cy@example.com", role: "admin" });
    expect(invited.invite).not.toHaveProperty("token_hash");

    expect(await (await call("GET", `/auth/invites/${invited.token}`)).json()).toEqual({
      email: "cy@example.com",
      role: "admin",
      workspace_name: "ada's workspace",
      has_account: false,
    });
    expect((await signup("mallory@example.com", { invite: invited.token })).response.status).toBe(403);

    const cy = await signup("cy@example.com", { invite: invited.token });
    expect(cy.data.workspaces.map((w: any) => [w.id, w.role])).toEqual([[ada.workspace, "admin"]]);
    // Used once.
    expect((await call("GET", `/auth/invites/${invited.token}`)).status).toBe(404);
    const team = await (
      await call("GET", `/app/workspaces/${ada.workspace}/members`, undefined, { cookie: ada.cookie })
    ).json();
    expect(team.members.map((m: any) => [m.email, m.role])).toEqual([
      ["ada@example.com", "owner"],
      ["cy@example.com", "admin"],
    ]);
    expect(team.invites).toEqual([]);
  });

  it("lets a person who has an account accept an invite, and replaces an older link", async () => {
    const ada = await signup("ada@example.com");
    const ben = await signup("ben@example.com");
    const first = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "ben@example.com" },
        { cookie: ada.cookie },
      )
    ).json();
    const second = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "ben@example.com" },
        { cookie: ada.cookie },
      )
    ).json();
    expect((await call("POST", `/auth/invites/${first.token}/accept`, undefined, { cookie: ben.cookie })).status).toBe(
      403,
    );
    expect((await call("POST", `/auth/invites/${second.token}/accept`, undefined, { cookie: ada.cookie })).status).toBe(
      403,
    );
    const accepted = await (
      await call("POST", `/auth/invites/${second.token}/accept`, undefined, { cookie: ben.cookie })
    ).json();
    expect(accepted.workspaces.map((w: any) => w.role).sort()).toEqual(["member", "owner"]);
    expect(
      (
        await call(
          "POST",
          `/app/workspaces/${ada.workspace}/invites`,
          { email: "ben@example.com" },
          { cookie: ada.cookie },
        )
      ).status,
    ).toBe(409);
  });

  it("ends an invite after seven days, or when it is revoked", async () => {
    const ada = await signup("ada@example.com");
    const a = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "cy@example.com" },
        { cookie: ada.cookie },
      )
    ).json();
    await call("DELETE", `/app/workspaces/${ada.workspace}/invites/${a.invite.id}`, undefined, { cookie: ada.cookie });
    expect((await call("GET", `/auth/invites/${a.token}`)).status).toBe(404);
    const b = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "dee@example.com" },
        { cookie: ada.cookie },
      )
    ).json();
    clock = new Date(NOW.getTime() + 8 * 86_400_000);
    expect((await call("GET", `/auth/invites/${b.token}`)).status).toBe(404);
  });

  it("limits what each role can do, and keeps one owner", async () => {
    const ada = await signup("ada@example.com");
    const invite = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "ben@example.com" },
        { cookie: ada.cookie },
      )
    ).json();
    const ben = await signup("ben@example.com", { invite: invite.token });
    const benId = ben.data.user.id;
    const adaId = ada.data.user.id;
    const members = `/app/workspaces/${ada.workspace}/members`;

    // A member uses the workspace but does not manage it.
    expect((await call("GET", members, undefined, { cookie: ben.cookie })).status).toBe(200);
    expect((await call("GET", `/app/workspaces/${ada.workspace}/keys`, undefined, { cookie: ben.cookie })).status).toBe(
      403,
    );
    expect(
      (
        await call(
          "POST",
          `/app/workspaces/${ada.workspace}/invites`,
          { email: "x@example.com" },
          { cookie: ben.cookie },
        )
      ).status,
    ).toBe(403);

    await call("PATCH", `${members}/${benId}`, { role: "admin" }, { cookie: ada.cookie });
    // An admin manages members, but not owners.
    expect((await call("PATCH", `${members}/${adaId}`, { role: "member" }, { cookie: ben.cookie })).status).toBe(403);
    expect(
      (
        await call(
          "POST",
          `/app/workspaces/${ada.workspace}/invites`,
          { email: "x@example.com", role: "owner" },
          { cookie: ben.cookie },
        )
      ).status,
    ).toBe(403);
    // The only owner cannot step down or leave.
    expect((await call("PATCH", `${members}/${adaId}`, { role: "admin" }, { cookie: ada.cookie })).status).toBe(409);
    expect((await call("DELETE", `${members}/${adaId}`, undefined, { cookie: ada.cookie })).status).toBe(409);
    expect((await call("DELETE", `${members}/${benId}`, undefined, { cookie: ben.cookie })).status).toBe(200);
    expect((await call("GET", members, undefined, { cookie: ben.cookie })).status).toBe(404);
  });
});

describe("status, slugs and sign-in times", () => {
  const status = (table: string, set: string, where: string) =>
    database.db.execute<Record<string, any>>(sql.raw(`UPDATE ${table} SET status = '${set}' WHERE ${where}`));

  it("refuses a disabled user at sign-in and ends their sessions", async () => {
    const ada = await signup("ada@example.com");
    await status("users", "disabled", "email = 'ada@example.com'");
    expect((await call("GET", "/auth/me", undefined, { cookie: ada.cookie })).status).toBe(401);
    expect((await call("POST", "/auth/login", { email: "ada@example.com", password: "correct horse" })).status).toBe(
      401,
    );
  });

  it("refuses the members and the keys of a suspended workspace", async () => {
    const ada = await signup("ada@example.com");
    const key = (
      await (
        await call(
          "POST",
          `/app/workspaces/${ada.workspace}/keys`,
          { name: "server", kind: "secret" },
          { cookie: ada.cookie },
        )
      ).json()
    ).secret;
    await status("workspaces", "suspended", `id = '${ada.workspace}'`);
    const members = await call("GET", `/app/workspaces/${ada.workspace}/members`, undefined, { cookie: ada.cookie });
    expect(members.status).toBe(403);
    expect((await call("GET", "/v1/stats", undefined, { cookie: ada.cookie, workspace: ada.workspace })).status).toBe(
      403,
    );
    const withKey = await call("GET", "/v1/stats", undefined, { key });
    expect(withKey.status).toBe(403);
    expect((await withKey.json()).error.type).toBe("workspace_suspended");
  });

  it("gives a suspended member no access, and does not count a suspended owner", async () => {
    const ada = await signup("ada@example.com");
    const invite = (
      await (
        await call(
          "POST",
          `/app/workspaces/${ada.workspace}/invites`,
          { email: "ben@example.com", role: "owner" },
          { cookie: ada.cookie },
        )
      ).json()
    ).token;
    const ben = await signup("ben@example.com", { invite });
    await status("memberships", "suspended", `user_id = '${ben.data.user.id}'`);
    expect(
      (await call("GET", `/app/workspaces/${ada.workspace}/members`, undefined, { cookie: ben.cookie })).status,
    ).toBe(403);
    // Ben is an owner, but suspended: Ada is the last owner who counts.
    const demote = await call(
      "PATCH",
      `/app/workspaces/${ada.workspace}/members/${ada.data.user.id}`,
      { role: "admin" },
      { cookie: ada.cookie },
    );
    expect(demote.status).toBe(409);
    expect((await demote.json()).error.type).toBe("last_owner");
  });

  it("gives each workspace a slug of its own", async () => {
    const ada = await signup("ada@example.com");
    const one = await (
      await call("POST", "/app/workspaces", { name: "Acme Payments!" }, { cookie: ada.cookie })
    ).json();
    const two = await (await call("POST", "/app/workspaces", { name: "acme payments" }, { cookie: ada.cookie })).json();
    expect([one.slug, two.slug]).toEqual(["acme-payments", "acme-payments-2"]);
  });

  it("records the time of each sign-in", async () => {
    await signup("ada@example.com");
    clock = new Date(NOW.getTime() + 3_600_000);
    await call("POST", "/auth/login", { email: "ada@example.com", password: "correct horse" });
    const [row] = (
      await database.db.execute<Record<string, any>>(sql`SELECT extract(epoch FROM last_login) * 1000 AS at FROM users`)
    ).rows;
    expect(Number(row!.at)).toBe(clock.getTime());
  });
});

describe("private and shared dashboards", () => {
  const dash = (o: { cookie: string; workspace: string }, method: string, path = "", body?: unknown) =>
    call(method, `/v1/dashboards${path}`, body, o);

  it("shows a private dashboard to its owner only, and a shared one to the workspace", async () => {
    const ada = await signup("ada@example.com");
    const invite = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "ben@example.com" },
        { cookie: ada.cookie },
      )
    ).json();
    const ben = { ...(await signup("ben@example.com", { invite: invite.token })), workspace: ada.workspace };

    const mine = await (await dash(ada, "POST", "", { name: "My dashboard", visibility: "private" })).json();
    const shared = await (await dash(ada, "POST", "", { name: "Fraud overview", visibility: "workspace" })).json();
    expect(mine).toMatchObject({ visibility: "private", owner: ada.data.user.id, mine: true, can_manage: true });

    expect((await (await dash(ada, "GET")).json()).dashboards.map((d: any) => d.name)).toEqual([
      "My dashboard",
      "Fraud overview",
    ]);
    const seenByBen = (await (await dash(ben, "GET")).json()).dashboards;
    expect(seenByBen.map((d: any) => [d.name, d.mine, d.can_manage])).toEqual([["Fraud overview", false, false]]);
    expect((await dash(ben, "GET", `/${mine.id}`)).status).toBe(404);
    expect((await dash(ben, "PUT", `/${mine.id}`, { name: "Taken" })).status).toBe(404);
    expect((await dash(ben, "DELETE", `/${mine.id}`)).status).toBe(404);

    // A member can change the tiles of a shared dashboard, but it stays the owner's.
    const tile = { id: "t1", title: "Decisions", view: "number", w: 3, query: { source: "decisions" } };
    expect(
      (await dash(ben, "PUT", `/${shared.id}`, { name: "Fraud overview", visibility: "workspace", tiles: [tile] }))
        .status,
    ).toBe(200);
    expect(
      (await dash(ben, "PUT", `/${shared.id}`, { name: "Fraud overview", visibility: "private", tiles: [tile] }))
        .status,
    ).toBe(403);
    expect(
      (await dash(ben, "PUT", `/${shared.id}`, { name: "Renamed", visibility: "workspace", tiles: [tile] })).status,
    ).toBe(403);
    expect((await dash(ben, "DELETE", `/${shared.id}`)).status).toBe(403);

    // The owner makes it private: it is gone for the others.
    expect(
      (await dash(ada, "PUT", `/${shared.id}`, { name: "Fraud overview", visibility: "private", tiles: [tile] }))
        .status,
    ).toBe(200);
    expect((await (await dash(ben, "GET")).json()).dashboards).toEqual([]);
    expect((await dash(ada, "DELETE", `/${shared.id}`)).status).toBe(200);
  });
});

describe("deleting", () => {
  it("lets only an owner delete a workspace, with its name, and removes its data and keys", async () => {
    const ada = await signup("ada@example.com");
    const invite = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "ben@example.com", role: "admin" },
        { cookie: ada.cookie },
      )
    ).json();
    const ben = await signup("ben@example.com", { invite: invite.token });
    const { secret } = await (
      await call("POST", `/app/workspaces/${ada.workspace}/keys`, { name: "k", kind: "secret" }, { cookie: ada.cookie })
    ).json();
    await call("POST", "/v1/events", { batch: [event("e1")] }, { key: secret });
    const other = await (await call("POST", "/app/workspaces", { name: "Second" }, { cookie: ada.cookie })).json();
    await call("POST", "/v1/events", { batch: [event("e1")] }, { cookie: ada.cookie, workspace: other.id });

    expect(
      (await call("DELETE", `/app/workspaces/${ada.workspace}`, { confirm: "ada's workspace" }, { cookie: ben.cookie }))
        .status,
    ).toBe(403);
    expect(
      (await call("DELETE", `/app/workspaces/${ada.workspace}`, { confirm: "wrong name" }, { cookie: ada.cookie }))
        .status,
    ).toBe(400);
    expect(
      (await call("DELETE", `/app/workspaces/${ada.workspace}`, { confirm: "ada's workspace" }, { cookie: ada.cookie }))
        .status,
    ).toBe(200);

    expect((await call("GET", "/v1/stats", undefined, { key: secret })).status).toBe(401);
    expect((await call("GET", "/v1/stats", undefined, { cookie: ada.cookie, workspace: ada.workspace })).status).toBe(
      403,
    );
    expect((await (await call("GET", "/auth/me", undefined, { cookie: ben.cookie })).json()).workspaces).toEqual([]);
    expect(
      (await (await call("GET", "/v1/stats", undefined, { cookie: ada.cookie, workspace: other.id })).json()).events,
    ).toBe(1);
  });

  it("deletes an account with its password, and the workspaces that only this person is in", async () => {
    const ada = await signup("ada@example.com");
    await call("POST", "/v1/events", { batch: [event("e1")] }, { cookie: ada.cookie, workspace: ada.workspace });
    expect((await call("DELETE", "/auth/me", { password: "wrong horse" }, { cookie: ada.cookie })).status).toBe(403);
    expect((await call("DELETE", "/auth/me", {}, { cookie: ada.cookie })).status).toBe(400);
    expect(
      await (await call("DELETE", "/auth/me", { password: "correct horse" }, { cookie: ada.cookie })).json(),
    ).toEqual({ ok: true, workspaces_deleted: 1 });
    expect((await call("GET", "/auth/me", undefined, { cookie: ada.cookie })).status).toBe(401);
    expect((await call("POST", "/auth/login", { email: "ada@example.com", password: "correct horse" })).status).toBe(
      401,
    );
    // The address is free again, and the old data is not there.
    const again = await signup("ada@example.com");
    expect(again.workspace).not.toBe(ada.workspace);
    expect(await new WorkspacesService(database.db).findById(ada.workspace)).toBeNull();
  });

  it("does not delete an account that is the only owner of a workspace with other members", async () => {
    const ada = await signup("ada@example.com");
    const invite = await (
      await call(
        "POST",
        `/app/workspaces/${ada.workspace}/invites`,
        { email: "ben@example.com" },
        { cookie: ada.cookie },
      )
    ).json();
    const ben = await signup("ben@example.com", { invite: invite.token });
    const refused = await call("DELETE", "/auth/me", { password: "correct horse" }, { cookie: ada.cookie });
    expect([refused.status, (await refused.json()).error.type]).toEqual([409, "sole_owner"]);

    // A member who owns nothing can go. The workspace stays.
    expect((await call("DELETE", "/auth/me", { password: "correct horse" }, { cookie: ben.cookie })).status).toBe(200);
    await call("PATCH", "/auth/me", { name: "Ada" }, { cookie: ada.cookie });
    const team = await (
      await call("GET", `/app/workspaces/${ada.workspace}/members`, undefined, { cookie: ada.cookie })
    ).json();
    expect(team.members.map((m: any) => m.email)).toEqual(["ada@example.com"]);
  });
});

describe("API keys", () => {
  const makeKey = async (o: { cookie: string; workspace: string }, body: Record<string, unknown>) =>
    (await call("POST", `/app/workspaces/${o.workspace}/keys`, body, { cookie: o.cookie })).json();

  it("shows a key once and stores only a hint", async () => {
    const ada = await signup("ada@example.com");
    const created = await makeKey(ada, { name: "backend", kind: "secret" });
    expect(created.secret).toMatch(/^ksk_.{32}$/);
    expect(created.key).toMatchObject({ name: "backend", kind: "secret", allowed_ips: [], revoked: null });
    expect(created.key.hint).toBe(`${created.secret.slice(0, 8)}…${created.secret.slice(-4)}`);

    const listed = await (
      await call("GET", `/app/workspaces/${ada.workspace}/keys`, undefined, { cookie: ada.cookie })
    ).json();
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    expect(listed.keys).toHaveLength(1);
  });

  it("lets a secret key use the whole data API for its workspace only", async () => {
    const ada = await signup("ada@example.com");
    const ben = await signup("ben@example.com");
    const { secret } = await makeKey(ada, { name: "backend", kind: "secret" });
    expect((await call("POST", "/v1/events", { batch: [event("e1")] }, { key: secret })).status).toBe(202);
    expect((await (await call("GET", "/v1/stats", undefined, { key: secret })).json()).events).toBe(1);
    expect(
      (await (await call("GET", "/v1/stats", undefined, { cookie: ben.cookie, workspace: ben.workspace })).json())
        .events,
    ).toBe(0);
    expect((await call("GET", "/v1/stats", undefined, { key: "ksk_not_a_real_key" })).status).toBe(401);
    expect(
      (await (await call("GET", `/app/workspaces/${ada.workspace}/keys`, undefined, { cookie: ada.cookie })).json())
        .keys[0].last_used,
    ).toBe(NOW.toISOString());
  });

  it("lets a public key send events and nothing else", async () => {
    const ada = await signup("ada@example.com");
    const { secret } = await makeKey(ada, { name: "website", kind: "public" });
    expect(secret).toMatch(/^kpk_/);
    const sent = await call("POST", "/v1/events", { batch: [event("e1")] }, { key: secret });
    expect(sent.status).toBe(202);
    // A browser on any origin may send events.
    expect(sent.headers.get("access-control-allow-origin")).toBe("*");

    for (const [method, path, body] of [
      ["GET", "/v1/stats", undefined],
      ["GET", "/v1/entities/user/u1", undefined],
      ["POST", "/v1/decide", { action: "payout", entities: { user: "u1" } }],
      ["POST", "/v1/events/decide", event("e2")],
      ["PUT", "/v1/actions/payout", { subject: "user", hold: "Hold?" }],
      ["POST", "/v1/labels", { batch: [{ entity: { type: "user", id: "u1" }, label: "x" }] }],
    ] as const) {
      const response = await call(method, path, body, { key: secret });
      expect([path, response.status, (await response.json()).error.type]).toEqual([path, 403, "public_key_scope"]);
    }
    // It cannot change facts about an entity through an event either.
    const withSet = await call(
      "POST",
      "/v1/events",
      { batch: [{ ...event("e3"), set: { user: { kyc_level: "full" } } }] },
      { key: secret },
    );
    expect([withSet.status, (await withSet.json()).error.type]).toEqual([403, "public_key_scope"]);
  });

  it("lets a public key be limited to websites", async () => {
    const ada = await signup("ada@example.com");
    const created = await makeKey(ada, {
      name: "website",
      kind: "public",
      allowed_origins: ["shop.example.com", "https://*.example.org"],
    });
    expect(created.key.allowed_origins).toEqual(["https://shop.example.com", "https://*.example.org"]);
    const send = (origin?: string) =>
      app.request("/v1/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${created.secret}`,
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ batch: [event(`e_${origin}`)] }),
      });
    expect((await send("https://shop.example.com")).status).toBe(202);
    expect((await send("https://www.example.org")).status).toBe(202);
    const refused = await send("https://other.test");
    expect([refused.status, (await refused.json()).error.type]).toEqual([403, "origin_not_allowed"]);
    // A request that names no website is refused as well.
    expect((await send()).status).toBe(403);

    expect(
      (await makeKey(ada, { name: "bad", kind: "public", allowed_origins: ["https://example.com/path"] })).error
        .message,
    ).toContain("example.com/path");
    expect(
      (await makeKey(ada, { name: "bad", kind: "secret", allowed_origins: ["https://example.com"] })).error.message,
    ).toContain("only a public key");
    expect((await makeKey(ada, { name: "open", kind: "public" })).key.allowed_origins).toEqual([]);
  });

  it("refuses a key from an address that is not on its list", async () => {
    const ada = await signup("ada@example.com");
    const { secret } = await makeKey(ada, {
      name: "backend",
      kind: "secret",
      allowed_ips: ["203.0.113.0/24", "198.51.100.9"],
    });
    expect((await call("GET", "/v1/stats", undefined, { key: secret, ip: "203.0.113.50" })).status).toBe(200);
    expect((await call("GET", "/v1/stats", undefined, { key: secret, ip: "198.51.100.9, 10.0.0.1" })).status).toBe(200);
    const refused = await call("GET", "/v1/stats", undefined, { key: secret, ip: "192.0.2.4" });
    expect([refused.status, (await refused.json()).error.type]).toEqual([403, "ip_not_allowed"]);
    expect((await call("GET", "/v1/stats", undefined, { key: secret })).status).toBe(403);
    expect((await makeKey(ada, { name: "bad", kind: "secret", allowed_ips: ["the office"] })).error.message).toContain(
      "the office",
    );
  });

  it("changes a key's name and restrictions, and the new restrictions apply at once", async () => {
    const ada = await signup("ada@example.com");
    const ben = await signup("ben@example.com");
    const edit = (id: string, body: unknown, as = ada) =>
      call("PATCH", `/app/workspaces/${as.workspace}/keys/${id}`, body, { cookie: as.cookie });
    const { secret, key } = await makeKey(ada, { name: "backend", kind: "secret" });
    expect((await call("GET", "/v1/stats", undefined, { key: secret, ip: "192.0.2.4" })).status).toBe(200);

    const changed = await (await edit(key.id, { name: " Backend (EU) ", allowed_ips: ["203.0.113.0/24"] })).json();
    expect(changed.key).toMatchObject({
      id: key.id,
      name: "Backend (EU)",
      allowed_ips: ["203.0.113.0/24"],
      hint: key.hint,
    });
    expect((await call("GET", "/v1/stats", undefined, { key: secret, ip: "192.0.2.4" })).status).toBe(403);
    expect((await call("GET", "/v1/stats", undefined, { key: secret, ip: "203.0.113.9" })).status).toBe(200);
    // Only the fields given change.
    expect((await (await edit(key.id, { allowed_ips: [] })).json()).key).toMatchObject({
      name: "Backend (EU)",
      allowed_ips: [],
    });

    const site = await makeKey(ada, { name: "website", kind: "public" });
    expect(
      (await (await edit(site.key.id, { allowed_origins: ["shop.example.com"] })).json()).key.allowed_origins,
    ).toEqual(["https://shop.example.com"]);

    const refused = async (id: string, body: unknown, as = ada) => {
      const response = await edit(id, body, as);
      return [response.status, (await response.json()).error.message];
    };
    expect(await refused(key.id, { allowed_origins: ["https://example.com"] })).toEqual([
      400,
      expect.stringContaining("only a public key"),
    ]);
    expect(await refused(key.id, { allowed_ips: ["the office"] })).toEqual([
      400,
      expect.stringContaining("the office"),
    ]);
    expect((await refused(key.id, {}))[0]).toBe(400);
    expect((await refused(key.id, { kind: "public" }))[0]).toBe(400);
    expect((await refused("key_unknown", { name: "x" }))[0]).toBe(404);
    expect((await refused(key.id, { name: "x" }, ben))[0]).toBe(404);
    await call("DELETE", `/app/workspaces/${ada.workspace}/keys/${key.id}`, undefined, { cookie: ada.cookie });
    expect(await refused(key.id, { name: "x" })).toEqual([409, "A revoked key cannot be changed"]);
  });

  it("stops a revoked key at once", async () => {
    const ada = await signup("ada@example.com");
    const { secret, key } = await makeKey(ada, { name: "backend", kind: "secret" });
    expect((await call("GET", "/v1/stats", undefined, { key: secret })).status).toBe(200);
    const after = await (
      await call("DELETE", `/app/workspaces/${ada.workspace}/keys/${key.id}`, undefined, { cookie: ada.cookie })
    ).json();
    expect(after.keys[0].revoked).toBe(NOW.toISOString());
    expect((await call("GET", "/v1/stats", undefined, { key: secret })).status).toBe(401);
  });
});

describe("Supabase sign-in", () => {
  const supabase = { url: "https://project.supabase.co", anonKey: "anon" };
  const identity = (token: string) =>
    ({
      good: {
        id: "sb_1",
        email: "Ada@Example.com",
        app_metadata: { provider: "google" },
        user_metadata: { full_name: "Ada L", given_name: "Ada", family_name: "Lovelace" },
      },
      other: { id: "sb_2", email: "ben@example.com" },
    })[token];
  const fakeSupabase = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://project.supabase.co/auth/v1/user");
    expect((init.headers as Record<string, string>).apikey).toBe("anon");
    const who = identity((init.headers as Record<string, string>).Authorization!.replace("Bearer ", ""));
    return new Response(JSON.stringify(who ?? { message: "invalid" }), { status: who ? 200 : 401 });
  }) as typeof fetch;

  it("is off unless it is configured", async () => {
    expect((await (await call("GET", "/auth/config")).json()).supabase).toBeNull();
    expect((await call("POST", "/auth/supabase", { access_token: "good" })).status).toBe(404);
  });

  it("starts a session for the person Supabase names, and creates the account the first time", async () => {
    build({ supabase, fetch: fakeSupabase });
    expect((await (await call("GET", "/auth/config")).json()).supabase).toEqual({
      url: supabase.url,
      anon_key: "anon",
      providers: [],
    });

    const first = await call("POST", "/auth/supabase", { access_token: "good" });
    const data = await first.json();
    expect(data.user).toMatchObject({ email: "ada@example.com", name: "Ada L" });
    expect(data.workspaces).toHaveLength(1);
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call("GET", "/auth/me", undefined, { cookie })).status).toBe(200);

    const again = await (await call("POST", "/auth/supabase", { access_token: "good" })).json();
    expect(again.user.id).toBe(data.user.id);
    expect((await call("POST", "/auth/supabase", { access_token: "forged" })).status).toBe(401);
  });

  it("keeps the names and the method that Supabase gives", async () => {
    build({ supabase, fetch: fakeSupabase });
    const data = await (await call("POST", "/auth/supabase", { access_token: "good" })).json();
    expect(data.user).toMatchObject({
      name: "Ada L",
      display_name: "Ada L",
      first_name: "Ada",
      last_name: "Lovelace",
      has_password: false,
    });
    const [row] = (
      await database.db.execute<Record<string, any>>(sql`SELECT auth, subject_id, password_hash FROM users`)
    ).rows;
    expect(row).toEqual({
      auth: { provider: "supabase", strategy: "google" },
      subject_id: "sb_1",
      password_hash: null,
    });
  });

  it("does not join an account that signs in with a password under the same address", async () => {
    build({ supabase, fetch: fakeSupabase });
    const ben = await signup("ben@example.com");
    const viaSupabase = await call("POST", "/auth/supabase", { access_token: "other" });
    expect(viaSupabase.status).toBe(409);
    expect((await viaSupabase.json()).error).toEqual({ type: "email_taken", message: "Sign in with your password" });
    expect((await call("POST", "/auth/login", { email: "ben@example.com", password: "correct horse" })).status).toBe(
      200,
    );
    expect((await call("GET", "/auth/me", undefined, { cookie: ben.cookie })).status).toBe(200);
  });

  it("refuses a disabled Supabase account", async () => {
    build({ supabase, fetch: fakeSupabase });
    await call("POST", "/auth/supabase", { access_token: "good" });
    await database.db.execute<Record<string, any>>(sql`UPDATE users SET status = 'disabled'`);
    const again = await call("POST", "/auth/supabase", { access_token: "good" });
    expect(again.status).toBe(403);
    expect((await again.json()).error.type).toBe("account_disabled");
  });

  it("gives a Supabase account no password in Kairos", async () => {
    build({ supabase, fetch: fakeSupabase });
    const first = await call("POST", "/auth/supabase", { access_token: "good" });
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const set = await call("POST", "/auth/password", { password: "battery staple" }, { cookie });
    expect(set.status).toBe(400);
    expect((await set.json()).error.type).toBe("password_not_used");
    expect((await call("POST", "/auth/login", { email: "ada@example.com", password: "battery staple" })).status).toBe(
      401,
    );
    // It confirms the deletion of the account with its email address.
    expect((await call("DELETE", "/auth/me", { confirm: "ada@example.com" }, { cookie })).status).toBe(200);
  });

  it("does not let a Supabase account in without a password use the password form", async () => {
    build({ supabase, fetch: fakeSupabase });
    await call("POST", "/auth/supabase", { access_token: "good" });
    expect((await call("POST", "/auth/login", { email: "ada@example.com", password: "" })).status).toBe(400);
    expect((await call("POST", "/auth/login", { email: "ada@example.com", password: "anything at all" })).status).toBe(
      401,
    );
  });
});

describe("Cognito sign-in", () => {
  const cognito: CognitoConfig = {
    domain: "https://kairos.auth.us-east-1.amazoncognito.com",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool",
    clientId: "client",
    clientSecret: "secret",
    publicUrl: "https://kairos.example.com",
    providers: ["Google"],
  };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = (claims: Record<string, unknown>, kid = "k1") => {
    const unsigned = `${b64({ alg: "RS256", kid })}.${b64(claims)}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  };
  const ada = {
    sub: "cg_1",
    email: "Ada@Example.com",
    email_verified: true,
    name: "Ada L",
    given_name: "Ada",
    family_name: "Lovelace",
    iss: cognito.issuer,
    aud: "client",
    token_use: "id",
    exp: NOW.getTime() / 1000 + 3600,
  };
  // The ID token and the access token that the next code is traded for.
  let token = "";
  let accessToken = "a";
  const accessTokenOf = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
  // What the fake user pool knows and was asked: GetUser and the MFA calls, with the person's access token.
  let mfaEnabled = false;
  let idpCalls: { action: string; body: Record<string, any> }[] = [];
  const fakeCognito = (async (url: string, init?: RequestInit) => {
    if (url === `${cognito.issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (url === "https://cognito-idp.us-east-1.amazonaws.com/") {
      const action = (init!.headers as Record<string, string>)["X-Amz-Target"]!.split(".")[1]!;
      const body = JSON.parse(init!.body as string);
      idpCalls.push({ action, body });
      if (body.AccessToken === "revoked")
        return Response.json(
          { __type: "NotAuthorizedException", message: "Access Token has been revoked" },
          { status: 400 },
        );
      if (action === "GetUser") return Response.json({ UserMFASettingList: mfaEnabled ? ["SOFTWARE_TOKEN_MFA"] : [] });
      if (action === "AssociateSoftwareToken") return Response.json({ SecretCode: "JBSWY3DPEHPK3PXP" });
      if (action === "VerifySoftwareToken")
        return body.UserCode === "123456"
          ? Response.json({ Status: "SUCCESS" })
          : Response.json(
              { __type: "CodeMismatchException", message: "Invalid code received for user" },
              { status: 400 },
            );
      if (action === "SetUserMFAPreference") {
        mfaEnabled = body.SoftwareTokenMfaSettings.Enabled;
        return Response.json({});
      }
    }
    expect(url).toBe(`${cognito.domain}/oauth2/token`);
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("client:secret").toString("base64")}`,
    );
    const body = new URLSearchParams(init!.body as string);
    expect(body.get("redirect_uri")).toBe("https://kairos.example.com/auth/cognito/callback");
    if (body.get("code") !== "good" || !body.get("code_verifier"))
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ id_token: token, access_token: accessToken, token_type: "Bearer" });
  }) as typeof fetch;

  beforeEach(() => {
    forgetKeys();
    token = idToken(ada);
    accessToken = "a";
    mfaEnabled = false;
    idpCalls = [];
    build({ cognito, fetch: fakeCognito });
  });

  /** Starts a sign-in and comes back from Cognito with the code; returns the callback's answer and the session cookie. */
  async function viaCognito(query = "", back: (state: string) => string = (state) => `code=good&state=${state}`) {
    const start = await call("GET", `/auth/cognito/start${query}`);
    const pending = start.headers.get("set-cookie")!.split(";")[0]!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const response = await call("GET", `/auth/cognito/callback?${back(state)}`, undefined, { cookie: pending });
    const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
    const session = cookies.find((c) => c.startsWith("kairos_session="));
    const access = cookies.find((c) => c.startsWith("kairos_cognito_access="));
    return {
      start,
      response,
      cookie: session?.split(";")[0],
      access,
      // Both cookies, as the browser sends them to /auth/mfa.
      both: [session?.split(";")[0], access?.split(";")[0]].filter(Boolean).join("; "),
      location: response.headers.get("location")!,
    };
  }
  const problemOf = (location: string) =>
    new URL(location, "https://kairos.example.com").searchParams.get("auth_error");

  it("is off unless it is configured", async () => {
    build();
    const config = await (await call("GET", "/auth/config")).json();
    expect(config).toMatchObject({ password: true, cognito: null });
    expect((await call("GET", "/auth/cognito/start")).status).toBe(404);
    expect((await call("GET", "/auth/cognito/callback?code=good")).status).toBe(404);
  });

  it("turns the Kairos password off, because Cognito keeps the passwords and the second factors", async () => {
    expect(await (await call("GET", "/auth/config")).json()).toMatchObject({
      password: false,
      cognito: { providers: ["Google"] },
    });
    expect((await signup("ben@example.com")).response.status).toBe(404);
    expect((await call("POST", "/auth/login", { email: "ben@example.com", password: "correct horse" })).status).toBe(
      404,
    );
  });

  it("sends the person to Cognito with PKCE, to the provider they chose, or to the sign-up form", async () => {
    const start = await call("GET", "/auth/cognito/start");
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(`${cognito.domain}/oauth2/authorize`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client",
      redirect_uri: "https://kairos.example.com/auth/cognito/callback",
      scope: "openid email profile aws.cognito.signin.user.admin",
      code_challenge_method: "S256",
    });
    expect(to.searchParams.get("code_challenge")).toBeTruthy();
    expect(to.searchParams.has("identity_provider")).toBe(false);
    expect(start.headers.get("set-cookie")).toMatch(/kairos_cognito=.*HttpOnly.*SameSite=Lax/);

    const google = new URL((await call("GET", "/auth/cognito/start?provider=Google")).headers.get("location")!);
    expect(google.searchParams.get("identity_provider")).toBe("Google");
    const signupPage = new URL((await call("GET", "/auth/cognito/start?screen=signup")).headers.get("location")!);
    expect(signupPage.pathname).toBe("/signup");
    expect((await call("GET", "/auth/cognito/start?provider=Facebook")).status).toBe(400);
  });

  it("starts a session for the person Cognito names, and creates the account the first time", async () => {
    const first = await viaCognito();
    expect(first.location).toBe("/");
    expect(first.cookie).toBeTruthy();
    const me = await (await call("GET", "/auth/me", undefined, { cookie: first.cookie })).json();
    expect(me.user).toMatchObject({ email: "ada@example.com", name: "Ada L", first_name: "Ada", has_password: false });
    expect(me.workspaces).toHaveLength(1);

    const again = await viaCognito();
    const second = await (await call("GET", "/auth/me", undefined, { cookie: again.cookie })).json();
    expect(second.user.id).toBe(me.user.id);
    const [row] = (await database.db.execute<Record<string, any>>(sql`SELECT auth, subject_id FROM users`)).rows;
    expect(row).toEqual({ auth: { provider: "cognito", strategy: "email_password" }, subject_id: "cg_1" });
  });

  it("knows a person who signs in with Google through Cognito", async () => {
    token = idToken({ ...ada, sub: "Google_1", identities: [{ providerName: "Google" }] });
    await viaCognito("?provider=Google");
    const [row] = (await database.db.execute<Record<string, any>>(sql`SELECT auth FROM users`)).rows;
    expect(row!.auth).toEqual({ provider: "cognito", strategy: "google" });
  });

  it("refuses a callback that does not match the sign-in that was started", async () => {
    const forged = await viaCognito("", () => "code=good&state=someone-else");
    expect(forged.cookie).toBeUndefined();
    expect(problemOf(forged.location)).toMatch(/Try again/);
    const noCookie = await call("GET", "/auth/cognito/callback?code=good&state=x");
    expect(problemOf(noCookie.headers.get("location")!)).toMatch(/Try again/);
    const badCode = await viaCognito("", (state) => `code=bad&state=${state}`);
    expect(problemOf(badCode.location)).toBe("Cognito did not accept this sign-in");
    const cancelled = await viaCognito("", () => "error=access_denied&error_description=User+cancelled");
    expect(problemOf(cancelled.location)).toBe("User cancelled");
    expect((await database.db.execute<Record<string, any>>(sql`SELECT 1 FROM users`)).rows).toHaveLength(0);
  });

  it("refuses an ID token that is forged, for another app, expired, or for an address that is not confirmed", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const unsigned = `${b64({ alg: "RS256", kid: "k1" })}.${b64(ada)}`;
    const bad = [
      `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), other).toString("base64url")}`,
      idToken({ ...ada, aud: "another-client" }),
      idToken({ ...ada, iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other" }),
      idToken({ ...ada, token_use: "access" }),
      idToken({ ...ada, exp: NOW.getTime() / 1000 - 1 }),
      idToken(ada, "unknown-key"),
    ];
    for (const forged of bad) {
      token = forged;
      const result = await viaCognito();
      expect(result.cookie).toBeUndefined();
      expect(problemOf(result.location)).toBe("Cognito returned a token that is not valid");
    }
    token = idToken({ ...ada, email_verified: false });
    expect(problemOf((await viaCognito()).location)).toMatch(/Confirm your email address/);
    expect((await database.db.execute<Record<string, any>>(sql`SELECT 1 FROM users`)).rows).toHaveLength(0);
  });

  it("does not join a person who signed in to Cognito another way under the same address", async () => {
    await viaCognito();
    token = idToken({ ...ada, sub: "Google_1", identities: [{ providerName: "Google" }] });
    const google = await viaCognito("?provider=Google");
    expect(google.cookie).toBeUndefined();
    expect(problemOf(google.location)).toMatch(/signs in another way/);
  });

  it("lets an invited person in when sign-up is closed, and only with the invited address", async () => {
    const owner = await viaCognito();
    const workspace = (await (await call("GET", "/auth/me", undefined, { cookie: owner.cookie })).json()).workspaces[0]
      .id;
    build({ cognito, fetch: fakeCognito, signup: false });
    const invited = await (
      await call(
        "POST",
        `/app/workspaces/${workspace}/invites`,
        { email: "cy@example.com", role: "member" },
        { cookie: owner.cookie },
      )
    ).json();

    token = idToken({ ...ada, sub: "cg_m", email: "mallory@example.com" });
    expect(problemOf((await viaCognito(`?invite=${invited.token}`)).location)).toBe("Sign-up is by invitation only");
    token = idToken({ ...ada, sub: "cg_cy", email: "cy@example.com" });
    expect(problemOf((await viaCognito()).location)).toBe("Sign-up is by invitation only");
    const cy = await viaCognito(`?invite=${invited.token}`);
    expect(cy.location).toBe("/");
    const me = await (await call("GET", "/auth/me", undefined, { cookie: cy.cookie })).json();
    expect(me.workspaces.map((w: { id: string }) => w.id)).toContain(workspace);
  });

  it("refuses a disabled Cognito account", async () => {
    await viaCognito();
    await database.db.execute(sql`UPDATE users SET status = 'disabled'`);
    const again = await viaCognito();
    expect(again.cookie).toBeUndefined();
    expect(problemOf(again.location)).toBe("This account is disabled");
  });

  it("signs out of Cognito too, so that the next sign-in asks again", async () => {
    const { cookie } = await viaCognito();
    const out = await (await call("POST", "/auth/logout", undefined, { cookie })).json();
    expect(out.redirect).toBe(
      `${cognito.domain}/logout?client_id=client&logout_uri=${encodeURIComponent("https://kairos.example.com/")}`,
    );
    expect((await call("GET", "/auth/me", undefined, { cookie })).status).toBe(401);
  });

  describe("two-factor authentication", () => {
    const nowSeconds = NOW.getTime() / 1000;
    const accessFor = (extra: Record<string, unknown> = {}) =>
      accessTokenOf({ sub: "cg_1", exp: nowSeconds + 3600, auth_time: nowSeconds - 60, ...extra });
    const mfa = (method: string, path: string, cookie: string, body?: unknown) =>
      call(method, `/auth/mfa${path}`, body, { cookie });

    it("keeps the access token in a cookie for /auth/mfa only, and comes back to the page it was asked for", async () => {
      accessToken = accessFor();
      const signedIn = await viaCognito(`?next=${encodeURIComponent("/#/settings/profile")}`);
      expect(signedIn.location).toBe("/#/settings/profile");
      expect(signedIn.access).toMatch(/Path=\/auth\/mfa/);
      expect(signedIn.access).toMatch(/HttpOnly/);
      expect(signedIn.access).toMatch(/SameSite=Strict/);
      expect(signedIn.access).toMatch(/Max-Age=3600/);
      // Never another site.
      for (const next of [
        "//evil.example",
        "https://evil.example",
        "/\\evil.example",
        "/\t/evil.example",
        "/\n/evil.example",
        "/\r/evil.example",
        "/ /evil.example",
      ])
        expect((await viaCognito(`?next=${encodeURIComponent(next)}`)).location).toBe("/");
    });

    it("asks for the password again with prompt=login", async () => {
      const to = new URL((await call("GET", "/auth/cognito/start?reauth=1")).headers.get("location")!);
      expect(to.searchParams.get("prompt")).toBe("login");
      expect(to.searchParams.get("scope")).toBe("openid email profile aws.cognito.signin.user.admin");
    });

    it("turns it on with a code from the app, and Cognito asks for it from then on", async () => {
      accessToken = accessFor();
      const { both } = await viaCognito();
      expect(await (await mfa("GET", "", both)).json()).toEqual({
        available: true,
        enabled: false,
        reauth_required: false,
      });

      const setup = await (await mfa("POST", "/setup", both)).json();
      expect(setup).toEqual({
        secret: "JBSWY3DPEHPK3PXP",
        otpauth_uri: "otpauth://totp/Kairos%3Aada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Kairos",
      });
      const wrong = await mfa("POST", "/verify", both, { code: "000000" });
      expect(wrong.status).toBe(400);
      expect((await wrong.json()).error.message).toMatch(/not correct/);
      expect((await mfa("POST", "/verify", both, { code: "12345" })).status).toBe(400);
      expect(mfaEnabled).toBe(false);

      expect(await (await mfa("POST", "/verify", both, { code: "123456" })).json()).toEqual({ enabled: true });
      expect(idpCalls.at(-1)).toEqual({
        action: "SetUserMFAPreference",
        body: { AccessToken: accessToken, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } },
      });
      expect((await (await mfa("GET", "", both)).json()).enabled).toBe(true);
    });

    it("sets up an authenticator app only after a recent sign-in, so a session left open cannot add one", async () => {
      accessToken = accessFor({ auth_time: nowSeconds - 20 * 60 });
      const old = await viaCognito();
      for (const [path, body] of [
        ["/setup", undefined],
        ["/verify", { code: "123456" }],
      ] as const) {
        const refused = await mfa("POST", path, old.both, body);
        expect(refused.status).toBe(403);
        expect((await refused.json()).error.type).toBe("reauth_required");
      }
      expect(idpCalls.map((call) => call.action)).not.toContain("AssociateSoftwareToken");
      expect(idpCalls.map((call) => call.action)).not.toContain("VerifySoftwareToken");
      expect(mfaEnabled).toBe(false);
    });

    it("turns it off only after a recent sign-in", async () => {
      mfaEnabled = true;
      accessToken = accessFor({ auth_time: nowSeconds - 20 * 60 });
      const old = await viaCognito();
      const refused = await mfa("POST", "/disable", old.both);
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.type).toBe("reauth_required");
      expect(mfaEnabled).toBe(true);

      accessToken = accessFor({ auth_time: nowSeconds - 30 });
      const fresh = await viaCognito("?reauth=1");
      expect(await (await mfa("POST", "/disable", fresh.both)).json()).toEqual({ enabled: false });
      expect(mfaEnabled).toBe(false);
    });

    it("asks to sign in again without a token, with another person's token, or with one Cognito refuses", async () => {
      const { cookie } = await viaCognito();
      expect(await (await mfa("GET", "", cookie!)).json()).toEqual({
        available: true,
        enabled: null,
        reauth_required: true,
      });
      expect((await mfa("POST", "/setup", cookie!)).status).toBe(403);

      const someoneElse = `kairos_cognito_access=${accessFor({ sub: "cg_other" })}`;
      expect((await (await mfa("GET", "", `${cookie}; ${someoneElse}`)).json()).reauth_required).toBe(true);
      const expired = `kairos_cognito_access=${accessFor({ exp: nowSeconds - 1 })}`;
      expect((await (await mfa("GET", "", `${cookie}; ${expired}`)).json()).reauth_required).toBe(true);
      expect(idpCalls).toHaveLength(0);

      // A token that reads well but that Cognito revoked (signed out elsewhere).
      accessToken = accessFor();
      const signedIn = await viaCognito();
      const revoked = signedIn.both.replace(/kairos_cognito_access=[^;]+/, `kairos_cognito_access=${accessFor()}`);
      expect((await (await mfa("GET", "", revoked)).json()).enabled).toBe(false);
      idpCalls = [];
      const revokedSetup = await call("POST", "/auth/mfa/setup", undefined, {
        cookie: `${signedIn.cookie}; kairos_cognito_access=revoked`,
      });
      expect(revokedSetup.status).toBe(403);
    });

    it("leaves a Google account's second factor to Google", async () => {
      token = idToken({ ...ada, sub: "Google_1", identities: [{ providerName: "Google" }] });
      accessToken = accessFor({ sub: "Google_1" });
      const { both } = await viaCognito("?provider=Google");
      expect(await (await mfa("GET", "", both)).json()).toEqual({ available: false, reason: "google" });
      expect((await mfa("POST", "/setup", both)).status).toBe(400);
    });

    it("is off without Cognito, and needs a session", async () => {
      expect((await call("GET", "/auth/mfa")).status).toBe(401);
      build();
      expect((await call("GET", "/auth/mfa")).status).toBe(404);
    });

    it("forgets the access token at sign-out", async () => {
      accessToken = accessFor();
      const { both } = await viaCognito();
      const out = await call("POST", "/auth/logout", undefined, { cookie: both });
      expect(out.headers.getSetCookie().find((c) => c.startsWith("kairos_cognito_access="))).toMatch(/Max-Age=0/);
    });
  });
});
