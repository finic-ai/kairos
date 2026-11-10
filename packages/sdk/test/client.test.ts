import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kairos, KairosApiError, KairosError, KairosTimeoutError } from "../src/index.js";

interface Call {
  path: string;
  auth: string | undefined;
  body: any;
}
type Reply = { status?: number; body?: unknown; delayMs?: number };

let server: Server;
let baseUrl: string;
let calls: Call[];
let methods: string[];
let replies: Record<string, Reply[]>;

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });

beforeEach(async () => {
  calls = [];
  methods = [];
  replies = {};
  server = createServer(async (req, res) => {
    const path = req.url!;
    methods.push(req.method!);
    calls.push({ path, auth: req.headers.authorization, body: JSON.parse(await read(req)) });
    const reply = replies[path]?.shift() ?? {
      body:
        path === "/v1/decide"
          ? { decision: "approve", risk_score: 3, probability: 0.03, reasons: [] }
          : { accepted: true },
    };
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));

const client = (options = {}) => new Kairos({ apiKey: "test_key", baseUrl, flushIntervalMs: 0, ...options });
const events = () => calls.filter((c) => c.path === "/v1/events");

describe("track", () => {
  it("lifts identifiers and sends the rest as properties", async () => {
    const kairos = client();
    kairos.track("transaction", {
      userId: "user_123",
      accountId: "account_456",
      recipientId: "recipient_789",
      bank_account_id: "ba_1",
      entities: { device: "dev_1" },
      amount: 9500,
      currency: "USD",
      timestamp: "2026-10-06T14:00:00Z",
      eventId: "evt_1",
    });
    await kairos.flush();

    expect(events()).toHaveLength(1);
    expect(events()[0]!.auth).toBe("Bearer test_key");
    expect(events()[0]!.body).toEqual({
      batch: [
        {
          id: "evt_1",
          type: "transaction",
          ts: "2026-10-06T14:00:00.000Z",
          entities: {
            user: "user_123",
            account: "account_456",
            recipient: "recipient_789",
            bank_account: "ba_1",
            device: "dev_1",
          },
          properties: { amount: 9500, currency: "USD" },
        },
      ],
    });
  });

  it("sends a batch when the queue reaches flushAt, in order", async () => {
    const kairos = client({ flushAt: 3 });
    for (let i = 0; i < 3; i++) kairos.track("login", { userId: "u", n: i });
    await new Promise((r) => setTimeout(r, 60));
    expect(events()).toHaveLength(1);

    for (let i = 3; i < 5; i++) kairos.track("login", { userId: "u", n: i });
    await kairos.flush();
    expect(events().map((c) => c.body.batch.map((e: any) => e.properties.n))).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
  });

  it("sends $set and $set_once for the entity an event is about", async () => {
    const kairos = client();
    kairos.track("kyc_completed", {
      userId: "u",
      level: "full",
      $set: { kyc_level: "full" },
      $set_once: { opened: "2021-03-04" },
      eventId: "e1",
      timestamp: "2026-10-01T10:00:00Z",
    });
    kairos.track("login", {
      userId: "u",
      deviceId: "d",
      $set: { user: { last_country: "GB" }, device: { os: "ios" } },
      eventId: "e2",
      timestamp: "2026-10-01T10:05:00Z",
    });
    kairos.track("login", { userId: "u", $set: {}, eventId: "e3", timestamp: "2026-10-01T10:06:00Z" });
    await kairos.flush();
    expect(events()[0]!.body.batch).toEqual([
      {
        id: "e1",
        type: "kyc_completed",
        ts: "2026-10-01T10:00:00.000Z",
        entities: { user: "u" },
        properties: { level: "full" },
        set: { user: { kyc_level: "full" } },
        set_once: { user: { opened: "2021-03-04" } },
      },
      {
        id: "e2",
        type: "login",
        ts: "2026-10-01T10:05:00.000Z",
        entities: { user: "u", device: "d" },
        properties: {},
        set: { user: { last_country: "GB" }, device: { os: "ios" } },
      },
      { id: "e3", type: "login", ts: "2026-10-01T10:06:00.000Z", entities: { user: "u" }, properties: {} },
    ]);
    // With two entities, the properties must say which one they are for.
    expect(() => kairos.track("login", { userId: "u", deviceId: "d", $set: { os: "ios" } })).toThrow(
      /Say which entity/,
    );
    expect(() => kairos.track("login", { userId: "u", $set: "full" as any })).toThrow(/must be an object/);
  });

  it("sends the stages of one record with a universal id and a status", async () => {
    const kairos = client();
    kairos.track("transaction", {
      userId: "u",
      universalId: "txn_1",
      status: "pending",
      usd: 500,
      eventId: "e1",
      timestamp: "2026-10-01T10:00:00Z",
    });
    kairos.track("transaction", {
      userId: "u",
      universalId: "txn_1",
      status: "completed",
      eventId: "e2",
      timestamp: "2026-10-01T10:05:00Z",
    });
    await kairos.flush();
    expect(events()[0]!.body.batch).toEqual([
      {
        id: "e1",
        type: "transaction",
        ts: "2026-10-01T10:00:00.000Z",
        entities: { user: "u" },
        properties: { usd: 500 },
        universal_id: "txn_1",
        status: "pending",
      },
      {
        id: "e2",
        type: "transaction",
        ts: "2026-10-01T10:05:00.000Z",
        entities: { user: "u" },
        properties: {},
        universal_id: "txn_1",
        status: "completed",
      },
    ]);
  });

  it("sends $session as the session of an event and of a decision, and leaves sessionId an entity", async () => {
    const kairos = client();
    kairos.track("login", {
      userId: "u",
      sessionId: "own_1",
      $session: "s_9",
      eventId: "e1",
      timestamp: "2026-10-01T10:00:00Z",
    });
    kairos.track("login", { userId: "u", $session: "", eventId: "e2", timestamp: "2026-10-01T10:01:00Z" });
    await kairos.flush();
    expect(events()[0]!.body.batch).toEqual([
      {
        id: "e1",
        type: "login",
        ts: "2026-10-01T10:00:00.000Z",
        entities: { user: "u", session: "own_1" },
        properties: {},
        session: "s_9",
      },
      { id: "e2", type: "login", ts: "2026-10-01T10:01:00.000Z", entities: { user: "u" }, properties: {} },
    ]);
    expect(() => kairos.track("login", { userId: "u", $session: { id: 1 } as any })).toThrow(/\$session/);
  });

  it("sends $trace as the span of an event, not as properties or entities", async () => {
    const kairos = client();
    kairos.track("tool_called", {
      agentId: "a1",
      tool: "lookup_order",
      eventId: "e1",
      timestamp: "2026-10-01T10:00:00Z",
      $trace: {
        traceId: "t1",
        spanId: "s2",
        parentSpanId: "s1",
        name: "execute_tool lookup_order",
        end: new Date("2026-10-01T10:00:01.5Z"),
        status: "error",
      },
    });
    await kairos.flush();
    expect(events()[0]!.body.batch[0]).toEqual({
      id: "e1",
      type: "tool_called",
      ts: "2026-10-01T10:00:00.000Z",
      entities: { agent: "a1" },
      properties: { tool: "lookup_order" },
      trace: {
        trace_id: "t1",
        span_id: "s2",
        parent_span_id: "s1",
        name: "execute_tool lookup_order",
        end: "2026-10-01T10:00:01.500Z",
        status: "error",
      },
    });
    expect(() => kairos.track("tool_called", { agentId: "a1", $trace: { traceId: "t1" } as any })).toThrow(/\$trace/);
  });

  it("sends on the timer", async () => {
    const kairos = client({ flushIntervalMs: 20 });
    kairos.track("login", { userId: "u" });
    await new Promise((r) => setTimeout(r, 120));
    expect(events()).toHaveLength(1);
    await kairos.shutdown();
  });

  it("rejects an event with no identifier, and any event after shutdown", async () => {
    const kairos = client();
    expect(() => kairos.track("login", {})).toThrow(KairosError);
    await kairos.shutdown();
    expect(() => kairos.track("login", { userId: "u" })).toThrow(/shutdown/);
  });

  it("retries a server error and delivers once", async () => {
    replies["/v1/events"] = [{ status: 503 }, { status: 500 }];
    const kairos = client();
    kairos.track("login", { userId: "u" });
    await kairos.flush();
    expect(events()).toHaveLength(3);
  });

  it("keeps events when the API is down, reports the error, and delivers on the next flush", async () => {
    const errors: Error[] = [];
    replies["/v1/events"] = [{ status: 503 }, { status: 503 }];
    const kairos = client({ maxRetries: 1, onError: (e: Error) => errors.push(e) });
    kairos.track("login", { userId: "u", n: 1 });
    await kairos.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KairosApiError);

    await kairos.flush();
    expect(events().at(-1)!.body.batch[0].properties.n).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("drops a batch the API rejects as invalid", async () => {
    const errors: Error[] = [];
    replies["/v1/events"] = [{ status: 400, body: { error: "bad event" } }];
    const kairos = client({ onError: (e: Error) => errors.push(e) });
    kairos.track("login", { userId: "u" });
    await kairos.flush();
    await kairos.flush();
    expect(events()).toHaveLength(1);
    expect((errors[0] as KairosApiError).status).toBe(400);
  });

  it("drops the oldest events beyond maxQueueSize", async () => {
    const errors: Error[] = [];
    const kairos = client({ flushAt: 100, maxQueueSize: 3, onError: (e: Error) => errors.push(e) });
    for (let i = 0; i < 5; i++) kairos.track("login", { userId: "u", n: i });
    await kairos.flush();
    expect(events()[0]!.body.batch.map((e: any) => e.properties.n)).toEqual([2, 3, 4]);
    expect(errors).toHaveLength(2);
  });
});

describe("decide", () => {
  it("sends queued events first, then returns the decision", async () => {
    replies["/v1/decide"] = [
      {
        body: {
          decision: "review",
          risk_score: 87,
          probability: 0.871,
          reasons: ["new_device", "new_beneficiary"],
          typology: "ato",
          rules: ["r1"],
          action: "bank_transfer@3",
          decision_id: "kdec_1",
        },
      },
    ];
    const kairos = client();
    kairos.track("login", { userId: "user_123", device: "d1" });
    const decision = await kairos.decide({ type: "bank_transfer", userId: "user_123", amount: 9500 });

    expect(calls.map((c) => c.path)).toEqual(["/v1/events", "/v1/decide"]);
    expect(calls[1]!.body).toEqual({
      action: "bank_transfer",
      entities: { user: "user_123" },
      properties: { amount: 9500 },
    });
    expect(decision).toEqual({
      decision: "review",
      riskScore: 87,
      probability: 0.871,
      reasons: ["new_device", "new_beneficiary"],
      typology: "ato",
      rules: ["r1"],
      action: "bank_transfer@3",
      decisionId: "kdec_1",
      fallback: false,
    });
  });

  it("throws an API error without retrying a client error", async () => {
    replies["/v1/decide"] = [{ status: 401, body: { error: "bad key" } }];
    await expect(client().decide({ type: "bank_transfer", userId: "u" })).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("throws on a timeout when there is no fallback", async () => {
    replies["/v1/decide"] = [{ delayMs: 300 }];
    await expect(client().decide({ type: "bank_transfer", userId: "u" }, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      KairosTimeoutError,
    );
  });

  it("returns the fallback action on a timeout", async () => {
    replies["/v1/decide"] = [{ delayMs: 300 }];
    const decision = await client().decide(
      { type: "bank_transfer", userId: "u" },
      { timeoutMs: 50, fallback: "review" },
    );
    expect(decision).toMatchObject({ decision: "review", fallback: true, reasons: [] });
    expect(decision.error).toBeInstanceOf(KairosTimeoutError);
  });

  it("returns the fallback action when the API stays down", async () => {
    replies["/v1/decide"] = [{ status: 503 }, { status: 503 }];
    const decision = await client({ maxRetries: 1 }).decide(
      { type: "bank_transfer", userId: "u" },
      { fallback: "approve" },
    );
    expect(decision).toMatchObject({ decision: "approve", fallback: true });
    expect(decision.error).toBeInstanceOf(KairosApiError);
  });

  it("rejects a decision with no identifier", async () => {
    await expect(client().decide({ type: "bank_transfer" })).rejects.toThrow(/userId/);
  });
});

describe("trackAndDecide", () => {
  it("sends queued events first, then one event that returns its decision", async () => {
    replies["/v1/events/decide"] = [
      {
        body: {
          decision: "block",
          risk_score: 96,
          probability: 0.96,
          reasons: ["new_account"],
          rules: [],
          action: "bank_transfer@2",
          decision_id: "kdec_9",
          event_id: "evt_req",
        },
      },
    ];
    const kairos = client();
    kairos.track("login", { userId: "user_123", deviceId: "d1" });
    const decision = await kairos.trackAndDecide("bank_transfer_requested", {
      userId: "user_123",
      beneficiaryId: "ben_1",
      amount: 9500,
      eventId: "evt_req",
      timestamp: "2026-10-06T14:00:00Z",
    });

    expect(calls.map((c) => c.path)).toEqual(["/v1/events", "/v1/events/decide"]);
    expect(calls[1]!.body).toEqual({
      id: "evt_req",
      type: "bank_transfer_requested",
      ts: "2026-10-06T14:00:00.000Z",
      entities: { user: "user_123", beneficiary: "ben_1" },
      properties: { amount: 9500 },
    });
    expect(decision).toMatchObject({
      decision: "block",
      riskScore: 96,
      decisionId: "kdec_9",
      eventId: "evt_req",
      fallback: false,
    });
  });

  it("keeps the event for the history when the decision cannot be reached", async () => {
    replies["/v1/events/decide"] = [{ status: 503 }, { status: 503 }];
    const kairos = client({ maxRetries: 1 });
    const decision = await kairos.trackAndDecide(
      "bank_transfer_requested",
      { userId: "u", eventId: "evt_down" },
      { fallback: "review" },
    );
    expect(decision).toMatchObject({ decision: "review", fallback: true, eventId: "evt_down" });

    await kairos.flush();
    expect(
      events()
        .at(-1)!
        .body.batch.map((e: any) => e.id),
    ).toEqual(["evt_down"]);
  });

  it("does not send again an event the API rejected", async () => {
    replies["/v1/events/decide"] = [{ status: 404, body: { error: { type: "no_trigger", message: "none" } } }];
    const kairos = client();
    await expect(kairos.trackAndDecide("unknown_request", { userId: "u" })).rejects.toMatchObject({ status: 404 });
    await kairos.flush();
    expect(events()).toHaveLength(0);
  });
});

describe("entity types", () => {
  it("defines an entity type", async () => {
    replies["/v1/entity-types/merchant"] = [{ body: { type: "merchant", description: "A business", link: true } }];
    const stored = await client().defineEntity("merchant", { description: "A business", link: true });
    expect(stored.type).toBe("merchant");
    expect(`${methods[0]} ${calls[0]!.path}`).toBe("PUT /v1/entity-types/merchant");
    expect(calls[0]!.body).toEqual({ description: "A business", link: true });
  });
});

describe("runWorkflow", () => {
  it("waits for the run, and keeps one idempotency key across a retry", async () => {
    const done = { id: "wfr_1", status: "done", output: { outcome: "review" } };
    replies["/v1/workflows/payout_check/runs"] = [{ status: 503 }, { body: done }];
    const run = await client().runWorkflow("payout_check", { user: "u1" }, { wait: true, timeoutSeconds: 2 });

    expect(run.output).toEqual({ outcome: "review" });
    expect(methods).toEqual(["POST", "POST"]);
    expect(calls[0]!.body).toMatchObject({ input: { user: "u1" }, wait: true, timeout_seconds: 2 });
    expect(calls[1]!.body.idempotency_key).toBe(calls[0]!.body.idempotency_key);
  });

  it("starts a run in the background, with the caller's key", async () => {
    await client().runWorkflow("nightly", {}, { idempotencyKey: "2026-10-27" });
    expect(calls[0]!.body).toEqual({ input: {}, idempotency_key: "2026-10-27" });
  });
});

describe("objects, labels and actions", () => {
  it("sends each to its endpoint", async () => {
    replies["/v1/actions/payout"] = [{ body: { name: "payout", version: 1, subject: "merchant", hold: "Hold?" } }];
    const kairos = client();
    const stored = await kairos.defineAction("payout", { subject: "merchant", hold: "Hold?" });
    await kairos.entity("merchant", "m1", { country: "PT" });
    await kairos.label({ type: "merchant", id: "m1" }, "fraud_confirmed", { source: "chargeback" });

    expect(stored.version).toBe(1);
    expect(calls.map((c, i) => `${methods[i]} ${c.path}`)).toEqual([
      "PUT /v1/actions/payout",
      "PUT /v1/objects",
      "POST /v1/labels",
    ]);
    expect(calls[0]!.body).toEqual({ subject: "merchant", hold: "Hold?" });
    // entity() stores through setObject.
    expect(calls[1]!.body).toEqual({ batch: [{ type: "merchant", id: "m1", properties: { country: "PT" } }] });
    expect(calls[2]!.body).toEqual({
      batch: [
        { entity: { type: "merchant", id: "m1" }, label: "fraud_confirmed", properties: { source: "chargeback" } },
      ],
    });
  });

  it("resolves a decision", async () => {
    replies["/v1/decisions/kdec_1/resolution"] = [
      {
        body: {
          id: "kdec_1",
          revision: 2,
          final_outcome: "block",
          resolution: { outcome: "block", by: "case-tool:alice", at: "2026-10-15T12:00:00.000Z" },
        },
      },
    ];
    const resolved = await client().resolve("kdec_1", "block", { note: "Mule pattern.", by: "case-tool:alice" });
    expect(resolved).toMatchObject({ revision: 2, final_outcome: "block" });
    expect(calls[0]!).toMatchObject({
      path: "/v1/decisions/kdec_1/resolution",
      body: { outcome: "block", note: "Mule pattern.", by: "case-tool:alice" },
    });
  });
});

describe("a runtime with no AbortSignal", () => {
  it("still times out a call, and leaves no timer when a call ends", async () => {
    const { vi } = await import("vitest");
    vi.stubGlobal("AbortSignal", undefined);
    try {
      const inits: RequestInit[] = [];
      const hanging = new Kairos({
        apiKey: "k",
        timeoutMs: 50,
        maxRetries: 0,
        fetch: ((_url: string, init: RequestInit) => {
          inits.push(init);
          return new Promise(() => {});
        }) as typeof fetch,
      });
      await expect(hanging.clientSettings()).rejects.toBeInstanceOf(KairosTimeoutError);
      expect(inits[0]!.signal).toBeUndefined();
      const decision = await hanging.decide({ type: "payment", userId: "u1" }, { fallback: "review", timeoutMs: 50 });
      expect(decision).toMatchObject({ decision: "review", fallback: true });

      vi.useFakeTimers();
      const answering = new Kairos({
        apiKey: "k",
        fetch: (async () => Response.json({ version: 1 })) as unknown as typeof fetch,
      });
      await answering.clientSettings();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
