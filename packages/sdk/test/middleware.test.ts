import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import expressApp, { Router, json, type Request } from "express";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { Kairos, KairosError, type ClientRoute, type ClientSettings, type Decision } from "../src/index.js";
import { express, hono, runWithContext, setContext, withoutContext, type KairosVariables } from "../src/middleware.js";
import { MAX_BODY_BYTES } from "../src/settings.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string };
      sessionId?: string;
    }
  }
}

/**
 * A client that records what it would send. It answers every decision with `decision`, and the
 * client settings with `settings`, or a 403 without them.
 */
function recorder(
  options: { onError?: (error: Error) => void; settings?: ClientSettings; decision?: Decision["decision"] } = {},
) {
  const { settings, decision = "approve", onError } = options;
  const calls: { path: string; body: any }[] = [];
  const kairos = new Kairos({
    apiKey: "test_key",
    baseUrl: "http://kairos.test",
    flushIntervalMs: 0,
    onError,
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/v1/client-settings")
        return new Response(JSON.stringify(settings ?? { error: { message: "forbidden" } }), {
          status: settings ? 200 : 403,
        });
      return new Response(
        JSON.stringify(path === "/v1/events" ? { accepted: 1 } : { decision, risk_score: 3, reasons: [] }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  const sent = async () => {
    await kairos.flush();
    return calls.filter((c) => c.path === "/v1/events").flatMap((c) => c.body.batch as any[]);
  };
  /** The events without the fields that differ on every run. */
  const events = async () => (await sent()).map(({ id: _id, ts: _ts, ...event }) => event);
  return { kairos, calls, events };
}

/** Serve an Express app for the length of `use`. */
async function serving(app: ReturnType<typeof expressApp>, use: (url: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the context of a request", () => {
  it("gives a call the entities and the session it does not name", async () => {
    const { kairos, calls, events } = recorder();
    await runWithContext(
      kairos,
      { entities: { user: "u1", device: "d1", ip: "203.0.113.7", empty: "", none: null }, session: "s1" },
      async () => {
        kairos.track("transaction", { amount: 900 });
        await kairos.decide({ type: "withdrawal", usd: 900 });
        await kairos.trackAndDecide("withdrawal_requested", { usd: 900 });
      },
    );
    const who = { entities: { user: "u1", device: "d1", ip: "203.0.113.7" }, session: "s1" };
    expect(await events()).toEqual([{ type: "transaction", properties: { amount: 900 }, ...who }]);
    expect(calls.find((c) => c.path === "/v1/decide")!.body).toEqual({
      action: "withdrawal",
      properties: { usd: 900 },
      ...who,
    });
    expect(calls.find((c) => c.path === "/v1/events/decide")!.body).toMatchObject({
      type: "withdrawal_requested",
      properties: { usd: 900 },
      ...who,
    });
  });

  it("lets the call win, and takes null as no session", async () => {
    const { kairos, events } = recorder();
    runWithContext(kairos, { entities: { user: "u1", device: "d1" }, session: "s1" }, () => {
      kairos.track("login", { deviceId: "d2", $session: "s2" });
      kairos.track("login", { $session: null as any });
      kairos.track("login", { $session: undefined });
    });
    expect(await events()).toEqual([
      { type: "login", entities: { user: "u1", device: "d2" }, properties: {}, session: "s2" },
      { type: "login", entities: { user: "u1", device: "d1" }, properties: {} },
      { type: "login", entities: { user: "u1", device: "d1" }, properties: {}, session: "s1" },
    ]);
  });

  it("adds nothing to a call about someone else", async () => {
    const { kairos, calls, events } = recorder();
    await runWithContext(
      kairos,
      { entities: { user: "agent_7", device: "agent_laptop", ip: "10.0.0.1" }, session: "agent_session" },
      async () => {
        kairos.track("contact_changed", { userId: "customer_1", field: "email" });
        kairos.track("contact_changed", { userId: "customer_1", field: "email", $session: "given" });
        await kairos.decide({ type: "withdrawal", userId: "customer_1" });
        // The same person, named in the call: the request still says where from.
        kairos.track("login", { userId: "agent_7" });
      },
    );
    expect(await events()).toEqual([
      { type: "contact_changed", entities: { user: "customer_1" }, properties: { field: "email" } },
      { type: "contact_changed", entities: { user: "customer_1" }, properties: { field: "email" }, session: "given" },
      {
        type: "login",
        entities: { device: "agent_laptop", ip: "10.0.0.1", user: "agent_7" },
        properties: {},
        session: "agent_session",
      },
    ]);
    expect(calls.find((c) => c.path === "/v1/decide")!.body).toEqual({
      action: "withdrawal",
      entities: { user: "customer_1" },
      properties: {},
    });
  });

  it("gives the device and the session to a sign-in, where the request has no user yet", async () => {
    const { kairos, events } = recorder();
    runWithContext(kairos, { entities: { device: "d1" }, session: "s1" }, () =>
      kairos.track("login", { userId: "u1" }),
    );
    expect(await events()).toEqual([
      { type: "login", entities: { device: "d1", user: "u1" }, properties: {}, session: "s1" },
    ]);
  });

  it("reads a subject other than the user", async () => {
    const { kairos, events } = recorder();
    runWithContext(kairos, { subject: "merchant", entities: { merchant: "m1", device: "d1" } }, () => {
      kairos.track("payout_requested", { merchantId: "m2" });
      kairos.track("payout_requested", { userId: "u9" });
    });
    expect(await events()).toEqual([
      { type: "payout_requested", entities: { merchant: "m2" }, properties: {} },
      { type: "payout_requested", entities: { merchant: "m1", device: "d1", user: "u9" }, properties: {} },
    ]);
  });

  it("puts $set on the entity the call is about, not on one the request added", async () => {
    const { kairos, events } = recorder();
    runWithContext(kairos, { entities: { user: "u1", device: "d1", ip: "203.0.113.7" } }, () => {
      kairos.track("kyc_completed", { $set: { kyc_level: "full" } });
      kairos.track("device_seen", { deviceId: "d1", $set: { os: "ios" } });
      kairos.track("login", { $set: { user: { country: "GB" }, device: { os: "ios" } } });
      expect(() => kairos.track("login", { userId: "u1", deviceId: "d1", $set: { os: "ios" } })).toThrow(
        /Say which entity/,
      );
    });
    runWithContext(kairos, { entities: { device: "d1", ip: "203.0.113.7" } }, () => {
      expect(() => kairos.track("seen", { $set: { os: "ios" } })).toThrow(/the event names device, ip/);
    });
    expect((await events()).map((e) => e.set)).toEqual([
      { user: { kyc_level: "full" } },
      { device: { os: "ios" } },
      { user: { country: "GB" }, device: { os: "ios" } },
    ]);
  });

  it("keeps two requests at the same time apart", async () => {
    const { kairos, events } = recorder();
    await Promise.all(
      ["a", "b", "c"].map((user, i) =>
        runWithContext(kairos, { entities: { user } }, async () => {
          await pause(15 - i * 5);
          kairos.track("login", { n: user });
        }),
      ),
    );
    expect((await events()).map((e) => [e.entities.user, e.properties.n])).toEqual([
      ["c", "c"],
      ["b", "b"],
      ["a", "a"],
    ]);
  });

  it("goes on with what the call names when the context cannot be read", async () => {
    const errors: Error[] = [];
    const { kairos, events } = recorder({ onError: (error) => errors.push(error) });
    runWithContext(kairos, { entities: { user: { id: 1 } as any } }, () => {
      kairos.track("login", { userId: "u1" });
      expect(() => kairos.track("login", {})).toThrow(/names no entity/);
    });
    expect(await events()).toEqual([{ type: "login", entities: { user: "u1" }, properties: {} }]);
    expect(errors.map((e) => e.message)).toEqual(
      Array(2).fill('The context gave a object as the id of "user". An id is text or a number.'),
    );
  });

  it("is the context of one client only, and can be left", async () => {
    const first = recorder();
    const second = recorder();
    runWithContext(second.kairos, { entities: { user: "other" } }, () => {
      runWithContext(first.kairos, { entities: { user: "u1" } }, () => {
        first.kairos.track("login", {});
        second.kairos.track("login", {});
        withoutContext(first.kairos, () => {
          expect(() => first.kairos.track("login", {})).toThrow(/did not run inside one of its requests/);
          second.kairos.track("login", {});
        });
      });
    });
    expect((await first.events()).map((e) => e.entities)).toEqual([{ user: "u1" }]);
    expect((await second.events()).map((e) => e.entities)).toEqual([{ user: "other" }, { user: "other" }]);
    // A client with no middleware says nothing about one.
    expect(() => recorder().kairos.track("login", {})).toThrow(
      /^Event "login" names no entity\. Add a property such as userId, or pass entities\.$/,
    );
  });

  it("takes what setContext gives over the resolvers, and only inside a request", async () => {
    const { kairos, events } = recorder();
    expect(() => setContext(kairos, { session: "s" })).toThrow(KairosError);
    runWithContext(kairos, { entities: { device: "d1" }, session: "old" }, () => {
      setContext(kairos, { entities: { user: "u1" }, session: "new" });
      kairos.track("login", {});
    });
    expect(await events()).toEqual([
      { type: "login", entities: { device: "d1", user: "u1" }, properties: {}, session: "new" },
    ]);
  });
});

describe("express", () => {
  /** An app with a sign-in that runs after the Kairos middleware, as it does in most apps. */
  function app(kairos: Kairos, routes: Parameters<typeof express<Request>>[1] = {}) {
    const server = expressApp();
    server.use(json());
    server.use(
      express<Request>(kairos, {
        entities: (req) => ({ user: req.user?.id, device: req.get("x-kairos-device"), ip: "203.0.113.7" }),
        session: (req) => req.sessionId,
        ...routes,
      }),
    );
    server.use((req, _res, next) => {
      const user = req.get("x-user");
      if (user) {
        req.user = { id: user };
        req.sessionId = `session_of_${user}`;
      }
      next();
    });
    return server;
  }
  const as = (user: string, init: RequestInit = {}) => ({
    ...init,
    headers: { "x-user": user, "x-kairos-device": "d1", "content-type": "application/json" },
  });

  it("reads the request when the call is made, after the sign-in, in code that has no request", async () => {
    const { kairos, calls, events } = recorder();
    const transfer = async (amount: number) => {
      await pause(5);
      kairos.track("transaction", { amount });
      return kairos.decide({ type: "withdrawal", amount });
    };
    const server = app(kairos);
    server.post("/transfers", async (req, res) => void res.json(await transfer(req.body.amount)));
    await serving(server, async (url) => {
      const answers = await Promise.all(
        ["u1", "u2", "u3"].map((user, i) =>
          fetch(`${url}/transfers`, as(user, { method: "POST", body: JSON.stringify({ amount: i }) })),
        ),
      );
      expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
    });
    const who = (n: number) => ({
      entities: { user: `u${n}`, device: "d1", ip: "203.0.113.7" },
      session: `session_of_u${n}`,
    });
    expect((await events()).sort((a, b) => a.properties.amount - b.properties.amount)).toEqual(
      [0, 1, 2].map((amount) => ({ type: "transaction", properties: { amount }, ...who(amount + 1) })),
    );
    expect(
      calls
        .filter((c) => c.path === "/v1/decide")
        .map((c) => c.body)
        .sort((a, b) => a.properties.amount - b.properties.amount),
    ).toEqual([0, 1, 2].map((amount) => ({ action: "withdrawal", properties: { amount }, ...who(amount + 1) })));
  });

  it("puts a client on the request that does not need the context to survive", async () => {
    const { kairos, events } = recorder();
    const server = app(kairos);
    server.post("/payees", (req, res) => {
      withoutContext(kairos, () => req.kairos.track("beneficiary_added", { payeeId: "p1" }));
      res.status(201).end();
    });
    await serving(server, async (url) => void (await fetch(`${url}/payees`, as("u1", { method: "POST" }))));
    expect(await events()).toEqual([
      {
        type: "beneficiary_added",
        entities: { user: "u1", device: "d1", ip: "203.0.113.7", payee: "p1" },
        properties: {},
        session: "session_of_u1",
      },
    ]);
  });

  it("sends the event of a route when the response finishes", async () => {
    const errors: Error[] = [];
    const { kairos, events } = recorder({ onError: (error) => errors.push(error) });
    const waited: Promise<void>[] = [];
    const server = app(kairos, {
      waitUntil: (_req, work) => waited.push(work),
      routes: {
        "post /api/payees/:id/": {
          type: "beneficiary_added",
          properties: (req) => ({ payeeId: req.params.id, country: req.body.country, http_status: "mine" }),
        },
        "PUT /api/password": { type: "password_changed", failed: "password_change_failed" },
        "POST /api/login": { type: "login", failed: "login_failed" },
        "GET /api/broken": "never",
        "POST /api/transfers": "transaction",
        "DELETE /api/payees/:id": {
          type: "beneficiary_removed",
          properties: () => {
            throw new Error("no properties");
          },
        },
      },
    });
    const api = Router();
    api.post("/payees/:id", (_req, res) => void res.status(201).end());
    api.delete("/payees/:id", (_req, res) => void res.status(204).end());
    api.put("/password", (req, res) => void res.status(req.body.ok ? 204 : 403).end());
    api.post("/login", (req, res) => {
      if (!req.body.ok) return void res.status(401).end();
      // The handler learns who it is and makes the session.
      setContext(kairos, { entities: { user: "u9" }, session: "fresh" });
      res.status(200).end();
    });
    api.get("/broken", (_req, res) => void res.status(500).end());
    api.get("/balance", (_req, res) => void res.end("1"));
    api.post("/transfers", (req, res) => {
      // The handler's own event has the amount, so the route's event is left out.
      kairos.track("transaction", { amount: req.body.amount });
      res.status(201).end();
    });
    server.use("/api", api);

    await serving(server, async (url) => {
      const call = (method: string, path: string, body: unknown = {}, user = "u1") =>
        fetch(url + path, {
          method,
          headers: { ...(user ? { "x-user": user } : {}), "x-kairos-device": "d1", "content-type": "application/json" },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
        });
      await call("POST", "/api/payees/p7?token=secret", { country: "NG" });
      await call("PUT", "/api/password", { ok: true });
      await call("PUT", "/api/password", { ok: false });
      await call("POST", "/api/login", { ok: false }, "");
      await call("POST", "/api/login", { ok: true }, "");
      await call("GET", "/api/broken");
      await call("GET", "/api/balance");
      await call("GET", "/api/nothing");
      await call("POST", "/api/transfers", { amount: 5 });
      await call("DELETE", "/api/payees/p7");
      await pause(20);
    });

    const who = { entities: { user: "u1", device: "d1", ip: "203.0.113.7" }, session: "session_of_u1" };
    const auto = (method: string, route: string, status: string) => ({
      source: "auto",
      http_method: method,
      http_route: route,
      http_status: status,
    });
    const anonymous = { device: "d1", ip: "203.0.113.7" };
    expect(await events()).toEqual([
      {
        type: "beneficiary_added",
        entities: { ...who.entities, payee: "p7" },
        session: who.session,
        properties: { country: "NG", ...auto("POST", "/api/payees/:id", "201") },
      },
      { type: "password_changed", ...who, properties: auto("PUT", "/api/password", "204") },
      { type: "password_change_failed", ...who, properties: auto("PUT", "/api/password", "403") },
      { type: "login_failed", entities: anonymous, properties: auto("POST", "/api/login", "401") },
      {
        type: "login",
        entities: { ...anonymous, user: "u9" },
        session: "fresh",
        properties: auto("POST", "/api/login", "200"),
      },
      { type: "transaction", ...who, properties: { amount: 5 } },
    ]);
    // Only for an event that was queued: not for the one left out, nor the one that failed.
    expect(waited).toHaveLength(5);
    expect(errors.map((e) => e.message)).toEqual(["no properties"]);
  });

  it("sends nothing for a request with no one to be about, and does not fail it", async () => {
    const errors: Error[] = [];
    const { kairos, events } = recorder({ onError: (error) => errors.push(error) });
    const server = expressApp();
    server.use(
      express<Request>(kairos, {
        entities: (req) => ({ user: req.user?.id }),
        routes: { "POST /payees": "beneficiary_added" },
      }),
    );
    server.post("/payees", (_req, res) => void res.status(201).end());
    await serving(server, async (url) => expect((await fetch(`${url}/payees`, { method: "POST" })).status).toBe(201));
    expect(await events()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("rejects a route that is not a method and a pattern", () => {
    const { kairos } = recorder();
    expect(() => express(kairos, { routes: { "/payees": "beneficiary_added" } })).toThrow(
      /must be a method and a route pattern/,
    );
    expect(() => express(kairos, { routes: { "POST /payees": { type: "" } } })).toThrow(/needs an event type/);
  });
});

describe("hono", () => {
  type Env = { Variables: KairosVariables & { user?: string } };

  function app(kairos: Kairos) {
    const server = new Hono<Env>();
    server.use(
      hono<Context<Env>>(kairos, {
        entities: (c) => ({ user: c.get("user"), device: c.req.header("x-kairos-device") }),
        session: (c) => (c.get("user") ? `session_of_${c.get("user")}` : undefined),
        routes: {
          "POST /api/payees/:id": { type: "beneficiary_added", properties: (c) => ({ payeeId: c.req.param("id") }) },
          "PUT /api/password": { type: "password_changed", failed: "password_change_failed" },
          "GET /*": "never",
          "GET /api/broken": "never",
        },
      }),
    );
    server.use(async (c, next) => {
      const user = c.req.header("x-user");
      if (user) c.set("user", user);
      await next();
    });
    const api = new Hono<Env>();
    api.post("/payees/:id", (c) => c.body(null, 201));
    api.put("/password", (c) => c.body(null, c.req.query("ok") ? 204 : 403));
    api.get("/broken", () => {
      throw new Error("broken");
    });
    api.post("/transfers", async (c) => {
      await pause(5);
      kairos.track("transaction", { amount: 5 });
      c.get("kairos").track("transfer_checked", {});
      return c.json(await kairos.decide({ type: "withdrawal", amount: 5 }));
    });
    server.route("/api", api);
    server.onError((_error, c) => c.body(null, 500));
    return server;
  }

  it("gives the context to calls in the request, and sends the events of its routes", async () => {
    const { kairos, calls, events } = recorder();
    const server = app(kairos);
    const call = (method: string, path: string, user = "u1") =>
      server.request(path, { method, headers: { ...(user ? { "x-user": user } : {}), "x-kairos-device": "d1" } });
    expect((await call("POST", "/api/transfers")).status).toBe(200);
    expect((await call("POST", "/api/payees/p7")).status).toBe(201);
    await call("PUT", "/api/password?ok=1");
    await call("PUT", "/api/password");
    await call("PUT", "/api/password", "");
    expect((await call("GET", "/api/broken")).status).toBe(500);
    expect((await call("GET", "/nothing")).status).toBe(404);

    const who = { entities: { user: "u1", device: "d1" }, session: "session_of_u1" };
    const auto = (method: string, route: string, status: string) => ({
      source: "auto",
      http_method: method,
      http_route: route,
      http_status: status,
    });
    expect(await events()).toEqual([
      { type: "transaction", ...who, properties: { amount: 5 } },
      { type: "transfer_checked", ...who, properties: {} },
      {
        type: "beneficiary_added",
        entities: { ...who.entities, payee: "p7" },
        session: who.session,
        properties: auto("POST", "/api/payees/:id", "201"),
      },
      { type: "password_changed", ...who, properties: auto("PUT", "/api/password", "204") },
      { type: "password_change_failed", ...who, properties: auto("PUT", "/api/password", "403") },
      { type: "password_change_failed", entities: { device: "d1" }, properties: auto("PUT", "/api/password", "403") },
    ]);
    expect(calls.find((c) => c.path === "/v1/decide")!.body).toEqual({
      action: "withdrawal",
      properties: { amount: 5 },
      ...who,
    });
  });
});

describe("the routes of the client settings", () => {
  const settingsWith = (
    routes: (Partial<ClientRoute> & Pick<ClientRoute, "route" | "mode" | "type">)[],
    routing: ClientSettings["routing"] = { mode: "monitor", other: "ignore" },
  ): ClientSettings => ({
    version: 1,
    consent: "not_required",
    defaults: { off: [], sessionCookie: "sid" },
    routing,
    pages: [],
    screens: [],
    routes: routes.map((route) => ({ fields: {}, enforce: false, ...route })),
  });
  const auto = (method: string, route: string, status?: string) => ({
    source: "auto",
    http_method: method,
    http_route: route,
    ...(status ? { http_status: status } : {}),
  });
  const byType = (events: any[]) => [...events].sort((a, b) => a.type.localeCompare(b.type));

  it("send the events of the routes that track, with their fields, once each", async () => {
    const { kairos, events } = recorder({
      settings: settingsWith([
        {
          route: "POST /api/payees/:id",
          mode: "track",
          type: "beneficiary_added",
          failed: "beneficiary_add_failed",
          fields: {
            payeeId: { from: "request.param", path: "id" },
            email: { from: "request.body", path: "$.email", kind: "email" },
            country: { from: "request.header", path: "x-country" },
          },
        },
        { route: "PUT /api/password", mode: "track", type: "password_changed" },
        {
          route: "POST /api/login",
          mode: "decide_response",
          type: "login",
          failed: "login_failed",
          fallback: "approve",
        },
        { route: "GET /api/broken", mode: "track", type: "never" },
      ]),
    });
    const server = expressApp();
    server.use(json());
    server.use(
      express<Request>(kairos, {
        entities: (req) => ({ user: req.get("x-user") }),
        routes: { "PUT /api/password": "password_changed" },
        clientSettings: true,
        hashKey: "hash-key",
      }),
    );
    server.post("/api/payees/:id", (req, res) => void res.status(req.body.ok ? 201 : 400).end());
    server.put("/api/password", (_req, res) => void res.status(204).end());
    server.post("/api/login", (_req, res) => void res.status(401).end());
    server.get("/api/broken", (_req, res) => void res.status(500).end());
    await pause(10);

    await serving(server, async (url) => {
      const call = (method: string, path: string, body?: unknown) =>
        fetch(url + path, {
          method,
          headers: {
            "x-user": "u1",
            "x-country": "NG",
            cookie: "theme=dark; sid=abc; kairos_device=browser_1",
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      await call("POST", "/api/payees/p7", { email: " Ada@Example.COM ", ok: true });
      await call("POST", "/api/payees/p8?x=1", { ok: false });
      await call("PUT", "/api/password");
      await call("POST", "/api/login");
      await call("GET", "/api/broken");
      await pause(20);
    });

    const session = createHmac("sha256", "hash-key").update("abc").digest("hex");
    expect(byType(await events())).toEqual([
      {
        type: "beneficiary_add_failed",
        entities: { user: "u1", device: "browser_1", payee: "p8" },
        session,
        properties: { country: "NG", ...auto("POST", "/api/payees/:id", "400") },
      },
      {
        type: "beneficiary_added",
        entities: { user: "u1", device: "browser_1", payee: "p7" },
        session,
        properties: { email: "ada@example.com", country: "NG", ...auto("POST", "/api/payees/:id", "201") },
      },
      {
        type: "password_changed",
        entities: { user: "u1", device: "browser_1" },
        session,
        properties: auto("PUT", "/api/password", "204"),
      },
    ]);
  });

  it("take the visit of the website script as the session when nothing else gives one", async () => {
    const { kairos, events } = recorder({
      settings: settingsWith([{ route: "POST /payees", mode: "track", type: "beneficiary_added" }]),
    });
    const server = expressApp();
    server.use(
      express<Request>(kairos, {
        entities: () => ({ user: "u1" }),
        session: (req) => req.get("x-session"),
        clientSettings: true,
      }),
    );
    server.post("/payees", (_req, res) => void res.status(201).end());
    await pause(10);
    await serving(server, async (url) => {
      const post = (headers: Record<string, string>) => fetch(`${url}/payees`, { method: "POST", headers });
      await post({ cookie: "kairos_visit=visit_1" });
      await post({ cookie: "kairos_visit=visit_1", "x-session": "login_9" });
      await pause(20);
    });
    expect((await events()).map((e) => e.session)).toEqual(["visit_1", "login_9"]);
  });

  it("decide a route before the handler, and act only when enforced in active mode", async () => {
    const route = {
      route: "POST /api/transfers",
      mode: "decide_request" as const,
      type: "transfer_requested",
      failed: "transfer_refused",
      fallback: "review" as const,
      enforce: true,
      block: { status: 409, body: { error: "held" } },
      fields: { amount: { from: "request.body" as const, path: "$.amount" } },
    };
    const withdrawal = {
      route: "POST /api/withdrawals",
      mode: "decide_request" as const,
      type: "withdrawal_requested",
      fallback: "review" as const,
      enforce: true,
      stepUp: { redirect: "/verify" },
    };
    const attempt = async (decision: Decision["decision"], mode: "monitor" | "active", path: string) => {
      const { kairos, calls, events } = recorder({
        decision,
        settings: settingsWith([route, withdrawal], { mode, other: "ignore" }),
      });
      const server = expressApp();
      server.use(json());
      server.use(express<Request>(kairos, { entities: (req) => ({ user: req.get("x-user") }), clientSettings: true }));
      let handled: string | undefined;
      server.post("/api/:what", (req, res) => {
        handled = req.kairosDecision?.decision;
        res.status(201).end();
      });
      await pause(10);
      let response!: globalThis.Response;
      await serving(server, async (url) => {
        response = await fetch(url + path, {
          method: "POST",
          redirect: "manual",
          headers: { "x-user": "u1", "content-type": "application/json" },
          body: JSON.stringify({ amount: 900 }),
        });
      });
      return { response, handled, asked: calls.find((c) => c.path === "/v1/events/decide")?.body, events };
    };

    const monitored = await attempt("block", "monitor", "/api/transfers");
    expect(monitored.response.status).toBe(201);
    expect(monitored.handled).toBe("block");
    expect(monitored.asked).toMatchObject({
      type: "transfer_requested",
      entities: { user: "u1" },
      properties: { amount: 900, ...auto("POST", "/api/transfers") },
    });

    const blocked = await attempt("block", "active", "/api/transfers");
    expect(blocked.response.status).toBe(409);
    expect(await blocked.response.json()).toEqual({ error: "held" });
    expect(blocked.handled).toBeUndefined();
    expect(await blocked.events()).toEqual([]);

    const stepped = await attempt("step_up", "active", "/api/withdrawals");
    expect(stepped.response.status).toBe(302);
    expect(stepped.response.headers.get("location")).toBe("/verify");

    const approved = await attempt("approve", "active", "/api/transfers");
    expect(approved.response.status).toBe(201);
    expect(approved.handled).toBe("approve");
  });

  it("do nothing when routing is off, or when the settings cannot be read, and fail no request", async () => {
    const errors: Error[] = [];
    const off = recorder({
      settings: settingsWith([{ route: "POST /payees", mode: "track", type: "beneficiary_added" }], {
        mode: "off",
        other: "ignore",
      }),
    });
    const unread = recorder({ onError: (error) => errors.push(error) });
    for (const { kairos, events } of [off, unread]) {
      const server = expressApp();
      server.use(express<Request>(kairos, { entities: () => ({ user: "u1" }), clientSettings: true }));
      server.post("/payees", (_req, res) => void res.status(201).end());
      await pause(10);
      await serving(server, async (url) => expect((await fetch(`${url}/payees`, { method: "POST" })).status).toBe(201));
      expect(await events()).toEqual([]);
    }
    expect(errors.map((e) => (e as any).status)).toEqual([403]);
  });

  it("say once that a field needs a hash key", async () => {
    const errors: Error[] = [];
    const { kairos, events } = recorder({
      onError: (error) => errors.push(error),
      settings: settingsWith([
        {
          route: "POST /payees",
          mode: "track",
          type: "beneficiary_added",
          fields: { accountId: { from: "request.header", path: "x-account", kind: "hmac" } },
        },
      ]),
    });
    const server = expressApp();
    server.use(express<Request>(kairos, { entities: () => ({ user: "u1" }), clientSettings: true }));
    server.post("/payees", (_req, res) => void res.status(201).end());
    await pause(10);
    await serving(server, async (url) => {
      for (let i = 0; i < 2; i++)
        await fetch(`${url}/payees`, { method: "POST", headers: { "x-account": "12345678" } });
      await pause(20);
    });
    expect((await events()).map((e) => e.entities)).toEqual([{ user: "u1" }, { user: "u1" }]);
    expect(errors.map((e) => e.message)).toEqual([
      'POST /payees: the field "accountId" is sent only as a hash, and there is no hash key.',
    ]);
  });

  it("read no body that is not JSON, or is too large", async () => {
    const { kairos, events } = recorder({
      settings: settingsWith([
        {
          route: "POST /files",
          mode: "track",
          type: "file_added",
          fields: { name: { from: "request.body", path: "$.name" } },
        },
      ]),
    });
    const server = expressApp();
    server.use(json({ type: () => true, limit: "1mb" }));
    server.use(express<Request>(kairos, { entities: () => ({ user: "u1" }), clientSettings: true }));
    server.post("/files", (_req, res) => void res.status(201).end());
    await pause(10);
    await serving(server, async (url) => {
      const send = (contentType: string, body: string) =>
        fetch(`${url}/files`, { method: "POST", headers: { "content-type": contentType }, body });
      await send("multipart/form-data; boundary=x", JSON.stringify({ name: "photo" }));
      await send("application/json", JSON.stringify({ name: "big", padding: "x".repeat(MAX_BODY_BYTES) }));
      await send("application/json", JSON.stringify({ name: "small" }));
      await pause(20);
    });
    expect((await events()).map((e) => e.properties.name)).toEqual([undefined, undefined, "small"]);
  });

  it("work the same in Hono, where the handler can still read the body", async () => {
    type Env = { Variables: KairosVariables };
    const build = (decision: Decision["decision"]) => {
      const recorded = recorder({
        decision,
        settings: settingsWith(
          [
            {
              route: "POST /api/transfers",
              mode: "decide_request",
              type: "transfer_requested",
              fallback: "review",
              enforce: true,
              fields: { amount: { from: "request.body", path: "$.amount" } },
            },
            {
              route: "POST /api/payees/:id",
              mode: "track",
              type: "beneficiary_added",
              fields: {
                payeeId: { from: "request.param", path: "id" },
                name: { from: "request.body", path: "$.name" },
              },
            },
          ],
          { mode: "active", other: "ignore" },
        ),
      });
      const server = new Hono<Env>();
      server.use(
        hono<Context<Env>>(recorded.kairos, {
          entities: (c) => ({ user: c.req.header("x-user") }),
          clientSettings: true,
        }),
      );
      server.post("/api/transfers", async (c) =>
        c.json({ body: await c.req.json(), decision: c.get("kairosDecision")?.decision }, 201),
      );
      server.post("/api/payees/:id", async (c) => c.json(await c.req.json(), 201));
      return { ...recorded, server };
    };
    const post = (server: Hono<Env>, path: string, body: unknown, length = true) => {
      const text = JSON.stringify(body);
      return server.request(path, {
        method: "POST",
        headers: {
          "x-user": "u1",
          "content-type": "application/json",
          ...(length ? { "content-length": String(text.length) } : {}),
        },
        body: text,
      });
    };

    const approving = build("approve");
    await pause(10);
    const transfer = await post(approving.server, "/api/transfers", { amount: 900 });
    expect(transfer.status).toBe(201);
    expect(await transfer.json()).toEqual({ body: { amount: 900 }, decision: "approve" });
    expect(await (await post(approving.server, "/api/payees/p7", { name: "Ada" })).json()).toEqual({ name: "Ada" });
    // With no length, Hono would read the body to its end, however large: it is left alone.
    expect(await (await post(approving.server, "/api/payees/p8", { name: "Bo" }, false)).json()).toEqual({
      name: "Bo",
    });
    await pause(10);
    expect((await approving.events()).map((e) => e.properties.name)).toEqual(["Ada", undefined]);

    const blocking = build("block");
    await pause(10);
    const blocked = await post(blocking.server, "/api/transfers", { amount: 900 });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "blocked" });
  });
});
