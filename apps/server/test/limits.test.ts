import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { apiKeys } from "../src/db/schema";
import { hashToken } from "../src/platform/crypto";
import { rateLimit, routeOf } from "../src/platform/rate-limit";
import { RateLimitsService } from "../src/services/rate_limit.service";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const START = new Date("2026-11-07T12:00:00Z");
const database = await testDatabase();
let clock: Date;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a" });
  clock = START;
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => ({ id: "dec_1", model: "grayson-1", answers: {}, usage: { input_tokens: 1 } }),
    now: () => clock,
    trustProxy: true,
  });
  await database.db.insert(apiKeys).values({
    id: "key_public",
    workspaceId: "workspace_a",
    environmentId: "workspace_a",
    name: "Website",
    kind: "public",
    keyHash: hashToken("kpk_site"),
    hint: "kpk_site",
    allowedIps: [],
    allowedOrigins: [],
    created: START,
    updated: START,
  });
});

function stream(total: number) {
  const counter = { pulled: 0 };
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counter.pulled >= total) return controller.close();
      counter.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { counter, body };
}

const streamed = (path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  app.request(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      duplex: "half",
    } as RequestInit),
  );

const sendEvent = (key: string, properties: Record<string, unknown>) =>
  app.request("/v1/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      batch: [{ id: "e1", type: "page_viewed", ts: START.toISOString(), entities: { device: "d1" }, properties }],
    }),
  });

describe("request bodies", () => {
  it("are bounded for every key, and more tightly for a public key", async () => {
    expect((await sendEvent("kpk_site", { blob: "x".repeat(3 * 1024 * 1024) })).status).toBe(413);
    expect((await sendEvent("key_a", { blob: "x".repeat(11 * 1024 * 1024) })).status).toBe(413);
    expect((await sendEvent("key_a", { blob: "x".repeat(600 * 1024) })).status).toBe(400);
    expect((await sendEvent("kpk_site", { blob: "x".repeat(1024) })).status).toBe(202);
  });

  it("stop a streamed body at the limit, without reading the rest", async () => {
    const events = stream(300 * 1024 * 1024);
    expect((await streamed("/v1/events", events.body, { Authorization: "Bearer kpk_site" })).status).toBe(413);
    expect(events.counter.pulled).toBeLessThan(3 * 1024 * 1024);

    const hook = stream(300 * 1024 * 1024);
    expect((await streamed("/v1/workflow-hooks/wfh_unknown", hook.body)).status).toBe(413);
    expect(hook.counter.pulled).toBeLessThan(2 * 1024 * 1024);
  });
});

describe("sign-in", () => {
  const login = (email: string, password: string) =>
    app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

  beforeEach(async () => {
    const response = await app.request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "correct horse", name: "Owner" }),
    });
    expect(response.status).toBe(200);
  });

  it("is refused for an address after 10 failures in 15 minutes, even with the right password", async () => {
    for (let i = 0; i < 10; i++) expect((await login("Owner@example.com", "wrong")).status).toBe(401);
    const refused = await login("owner@example.com", "correct horse");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login("nobody@example.com", "wrong")).status).toBe(401);

    clock = new Date(START.getTime() + 16 * 60 * 1000);
    expect((await login("owner@example.com", "correct horse")).status).toBe(200);
  });

  it("lets no more than 10 parallel sign-ins for an address check the password", async () => {
    const answers = await Promise.all(Array.from({ length: 30 }, () => login("owner@example.com", "wrong")));
    const statuses = answers.map((a) => a.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
  });

  it("forgets the failures of an address after a sign-in", async () => {
    for (let i = 0; i < 9; i++) await login("owner@example.com", "wrong");
    expect((await login("owner@example.com", "correct horse")).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login("owner@example.com", "wrong")).status).toBe(401);
    expect((await login("owner@example.com", "correct horse")).status).toBe(200);
  });
});

describe("rate limits", () => {
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const signup = (email: string, ip = "203.0.113.9") =>
    app.request("/auth/signup", {
      method: "POST",
      ...json({ email, password: "correct horse", name: "P" }, { "X-Forwarded-For": ip }),
    });

  it("allow 20 sign-ups from one IP address in an hour", async () => {
    for (let i = 0; i < 20; i++) expect((await signup(`p${i}@example.com`)).status).toBe(200);
    const refused = await signup("p20@example.com");
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as any).error.type).toBe("rate_limited");
    expect((await signup("p21@example.com", "198.51.100.1")).status).toBe(200);
    expect((await signup("p23@example.com", "not an address")).status).toBe(200);
    clock = new Date(START.getTime() + 61 * 60 * 1000);
    expect((await signup("p22@example.com")).status).toBe(200);
  });

  it("allow 10 checks of a signed-in person's password in 15 minutes", async () => {
    const made = await signup("owner@example.com");
    const cookie = (made.headers.get("set-cookie") ?? "").split(";")[0]!;
    const change = (current: string) =>
      app.request("/auth/password", {
        method: "POST",
        ...json({ current, password: "new horse!" }, { Cookie: cookie }),
      });
    for (let i = 0; i < 10; i++) expect((await change("wrong")).status).toBe(403);
    expect((await change("correct horse")).status).toBe(429);
    const remove = await app.request("/auth/me", {
      method: "DELETE",
      ...json({ password: "correct horse" }, { Cookie: cookie }),
    });
    expect(remove.status).toBe(429);
  });

  it("allow 600 requests a minute for one public key from one IP address", async () => {
    const send = (ip: string) =>
      app.request("/v1/events", {
        method: "POST",
        ...json(
          { batch: [{ id: `e_${ip}`, type: "page_viewed", ts: START.toISOString(), entities: { device: "d1" } }] },
          { Authorization: "Bearer kpk_site", "X-Forwarded-For": ip },
        ),
      });
    await database.db.execute(
      sql`INSERT INTO rate_limits (key, resource, ip, hits, expires) VALUES ('public:key_public|203.0.113.7', 'public_key', '203.0.113.7', 600, ${new Date(START.getTime() + 30_000)})`,
    );
    const refused = await send("203.0.113.7");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBe(30);
    expect((await send("203.0.113.8")).status).toBe(202);
    expect((await sendEvent("key_a", {})).status).toBe(202);
  });

  it("allow 30,000 requests a minute for one public key from all IP addresses", async () => {
    await database.db.execute(
      sql`INSERT INTO rate_limits (key, resource, hits, expires) VALUES ('public:key_public', 'public_key', 30000, ${new Date(START.getTime() + 20_000)})`,
    );
    const send = (ip: string) =>
      app.request("/v1/events", {
        method: "POST",
        ...json(
          { batch: [{ id: `e_${ip}`, type: "page_viewed", ts: START.toISOString(), entities: { device: "d1" } }] },
          { Authorization: "Bearer kpk_site", "X-Forwarded-For": ip },
        ),
      });
    const refused = await send("198.51.100.20");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBe(20);
    expect((await sendEvent("key_a", {})).status).toBe(202);
    clock = new Date(START.getTime() + 21_000);
    expect((await send("198.51.100.21")).status).toBe(202);
  });

  it("are removed by the hourly clean-up once they expire", async () => {
    const limits = new RateLimitsService(database.db);
    await limits.hit(
      [{ key: "signup:ip:203.0.113.1", resource: "signup", ip: "203.0.113.1", max: 1, windowMs: 60_000 }],
      START,
    );
    expect(
      (
        await database.db.execute<{ resource: string; ip: string }>(
          sql`SELECT resource, host(ip) AS ip FROM rate_limits`,
        )
      ).rows,
    ).toEqual([{ resource: "signup", ip: "203.0.113.1" }]);
    await RateLimitsService.purgeExpired(database.db, new Date(START.getTime() + 61_000));
    const left = await database.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rate_limits`);
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe("the rate limit middleware", () => {
  const limited = (c: Parameters<typeof routeOf>[0]) =>
    c.req.header("x-skip") ? [] : [{ key: `things:${routeOf(c)}`, resource: routeOf(c), max: 2, windowMs: 60_000 }];

  const check = async (outer: Hono) => {
    const post = (id: string, headers: Record<string, string> = {}) =>
      outer.request(`/v1/things/${id}`, { method: "POST", headers });
    expect((await post("a")).status).toBe(200);
    expect((await post("b")).status).toBe(200);
    const refused = await post("c");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBe(60);
    expect((await post("d", { "x-skip": "1" })).status).toBe(200);
    expect(
      (await database.db.execute<{ resource: string; hits: number }>(sql`SELECT resource, hits::int FROM rate_limits`))
        .rows,
    ).toEqual([{ resource: "POST /v1/things/:id", hits: 3 }]);
  };

  it("limits a route by its pattern, from middleware on the route", async () => {
    const limiter = new RateLimitsService(database.db);
    const inner = new Hono();
    inner.post(
      "/things/:id",
      rateLimit(limiter, () => clock, limited),
      (c) => c.json({ ok: true }),
    );
    await check(new Hono().route("/v1", inner));
  });

  it("limits a route by its pattern, from app.use for many routes", async () => {
    const limiter = new RateLimitsService(database.db);
    const outer = new Hono();
    outer.use(
      "/v1/*",
      rateLimit(limiter, () => clock, limited),
    );
    const inner = new Hono();
    inner.use("*", async (_c, next) => next());
    inner.post("/things/:id", (c) => c.json({ ok: true }));
    inner.get("/things/:id", (c) => c.json({ ok: true }));
    outer.route("/v1", inner);
    await check(outer);
  });
});
