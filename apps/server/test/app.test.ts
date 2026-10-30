import type { GraysonRequest, GraysonResponse } from "@kairos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const NOW = new Date("2026-10-06T14:00:00Z");
const database = await testDatabase();
let app: ReturnType<typeof createApp>;
let seen: GraysonRequest[];
let answer: GraysonResponse["answers"];

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
  seen = [];
  answer = { hold: { type: "noul", value: false, probability: 0.04 } };
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async (request) => {
      seen.push(request);
      return { id: "dec_1", model: "grayson-1", answers: answer, usage: { input_tokens: 1 } };
    },
    now: () => NOW,
  });
});

const call = (method: string, path: string, body?: unknown, key = "key_a") =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let n = 0;
const event = (
  type: string,
  ts: string,
  entities: Record<string, string>,
  properties: Record<string, unknown> = {},
) => ({
  id: `evt_${++n}`,
  type,
  ts,
  entities,
  properties,
});
const track = (batch: unknown[], key?: string) => call("POST", "/v1/events", { batch }, key);

const payout = { subject: "merchant", hold: "Should this payout be held because the merchant shows signs of fraud?" };

describe("auth", () => {
  it("rejects a missing or unknown key", async () => {
    expect((await app.request("/v1/actions")).status).toBe(401);
    expect((await call("GET", "/v1/actions", undefined, "nope")).status).toBe(401);
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("events", () => {
  it("accepts any event type and treats the id as an idempotency key", async () => {
    const batch = [
      event("shipment_created", "2026-10-01T10:00:00Z", { merchant: "m1", courier: "c9" }, { parcels: 3 }),
    ];
    expect(await (await track(batch)).json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(await (await track(batch)).json()).toEqual({ accepted: 0, duplicates: 1 });
  });

  it("rejects an event with no entity or a bad timestamp", async () => {
    const noEntity = await track([{ id: "x", type: "t", ts: "2026-10-01T10:00:00Z", entities: {} }]);
    expect(noEntity.status).toBe(400);
    expect((await noEntity.json()).error.message).toContain("at least one entity");
    expect((await track([{ id: "x", type: "t", ts: "yesterday", entities: { user: "u" } }])).status).toBe(400);
  });
});

describe("templates", () => {
  it("offers templates without defining anything", async () => {
    const withTemplates = createApp({
      repos: createRepositories(database.db),
      environments: environmentsRepository(database.db),
      accounts: tenancyRepository(database.db),
      decider: async () => ({ id: "d", model: "grayson-1", answers: answer, usage: { input_tokens: 1 } }),
      templates: [{ name: "payout", ...payout }],
    });
    const get = (path: string) => withTemplates.request(path, { headers: { Authorization: "Bearer key_a" } });
    expect(await (await get("/v1/templates")).json()).toEqual({ templates: [{ name: "payout", ...payout }] });
    expect((await (await get("/v1/actions")).json()).actions).toEqual([]);
    expect(await (await call("GET", "/v1/templates")).json()).toEqual({ templates: [] });
  });
});

describe("actions", () => {
  it("stores a definition, versions a change and ignores a repeat", async () => {
    expect((await (await call("PUT", "/v1/actions/payout", payout)).json()).version).toBe(1);
    expect((await (await call("PUT", "/v1/actions/payout", payout)).json()).version).toBe(1);
    const changed = await (
      await call("PUT", "/v1/actions/payout", { ...payout, hold: "Should this payout be held?" })
    ).json();
    expect(changed.version).toBe(2);
    expect((await (await call("GET", "/v1/actions")).json()).actions).toHaveLength(1);
    expect((await (await call("GET", "/v1/actions/payout")).json()).hold).toBe("Should this payout be held?");
  });

  it("keeps a display name beside the key, and does not make a version for a new one", async () => {
    const first = await (await call("PUT", "/v1/actions/payout", { ...payout, displayName: "Payout" })).json();
    expect([first.name, first.displayName, first.version]).toEqual(["payout", "Payout", 1]);
    const renamed = await (
      await call("PUT", "/v1/actions/payout", { ...payout, displayName: "Merchant Payout" })
    ).json();
    expect([renamed.displayName, renamed.version]).toEqual(["Merchant Payout", 1]);
    expect((await (await call("GET", "/v1/actions/payout")).json()).displayName).toBe("Merchant Payout");
    // A change to the wording is still a new version, and keeps the name.
    const reworded = await (
      await call("PUT", "/v1/actions/payout", {
        ...payout,
        displayName: "Merchant Payout",
        hold: "Should this payout be held?",
      })
    ).json();
    expect([reworded.displayName, reworded.version]).toEqual(["Merchant Payout", 2]);
    expect((await call("PUT", "/v1/actions/payout", { ...payout, displayName: "" })).status).toBe(400);
  });

  it("rejects an invalid definition with the reasons", async () => {
    const response = await call("PUT", "/v1/actions/payout", {
      subject: "merchant",
      hold: "",
      reasons: { one: "only one" },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/hold.*reasons needs 2/);
  });
});

describe("decide", () => {
  it("needs a defined action and the action's subject", async () => {
    const unknown = await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1" } });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.type).toBe("unknown_action");

    await call("PUT", "/v1/actions/payout", payout);
    const noSubject = await call("POST", "/v1/decide", { action: "payout", entities: { user: "u1" } });
    expect(noSubject.status).toBe(400);
    expect((await noSubject.json()).error.message).toContain("entities.merchant");
  });

  it("builds the context from the subject's events, object, labels and links", async () => {
    await call("PUT", "/v1/actions/payout", { ...payout, context: { recentEvents: 2 } });
    await call("PUT", "/v1/objects", {
      batch: [{ type: "merchant", id: "m1", properties: { country: "PT", category: "electronics" } }],
    });
    await track([
      ...Array.from({ length: 5 }, (_, i) =>
        event("order_paid", `2026-09-0${i + 1}T09:00:00Z`, { merchant: "m1" }, { usd: 100 + i }),
      ),
      event("bank_account_changed", "2026-10-06T13:00:00Z", { merchant: "m1", bank_account: "ba_7", device: "d1" }),
      event("login", "2026-10-06T13:30:00Z", { merchant: "m1", device: "d1" }),
      // Two other merchants use the same bank account; one is new and one is known fraud.
      event("bank_account_changed", "2026-06-01T10:00:00Z", { merchant: "m2", bank_account: "ba_7" }),
      event("bank_account_changed", "2026-09-30T10:00:00Z", { merchant: "m3", bank_account: "ba_7" }),
      // Another project's data must never appear.
    ]);
    await track(
      [event("bank_account_changed", "2026-09-30T10:00:00Z", { merchant: "m9", bank_account: "ba_7" })],
      "key_b",
    );
    await call("POST", "/v1/labels", { batch: [{ entity: { type: "merchant", id: "m2" }, label: "fraud_confirmed" }] });
    await call("PUT", "/v1/objects", {
      batch: [{ type: "bank_account", id: "ba_7", properties: { country: "LT", opened_days_ago: 4 } }],
    });

    answer = {
      hold: { type: "noul", value: true, probability: 0.93 },
    };
    const response = await call("POST", "/v1/decide", {
      action: "payout",
      entities: { merchant: "m1", bank_account: "ba_7" },
      properties: { usd: 4200 },
    });
    expect(response.status).toBe(200);
    const decision = await response.json();
    expect(decision).toMatchObject({ decision: "block", risk_score: 93, reasons: [], rules: [], action: "payout@1" });
    expect(decision.decision_id).toMatch(/^kdec_/);

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!.questions)).toEqual(["hold"]);
    const context = seen[0]!.context as any;
    expect(context.subject).toEqual({
      country: "PT",
      category: "electronics",
      type: "merchant",
      id: "m1",
      first_seen: "2026-09-01T09:00:00",
    });
    expect(context.baseline_of_older_events.event_types.order_paid).toMatchObject({
      count: 5,
      fields: { usd: { median: 102, max: 104 } },
    });
    expect(context.recent_events).toEqual([
      { bank_account: "ba_7", device: "d1", ts: "2026-10-06T13:00:00", type: "bank_account_changed" },
      { device: "d1", ts: "2026-10-06T13:30:00", type: "login" },
    ]);
    expect(context.pending_action).toEqual({
      usd: 4200,
      bank_account: "ba_7",
      type: "payout",
      requested_at: "2026-10-06T14:00:00",
    });
    expect(context.linked_entities).toEqual({
      "bank_account ba_7": {
        about: { country: "LT", opened_days_ago: 4 },
        first_seen: "2026-06-01T10:00:00",
        other_merchants: 2,
        other_merchants_by_label: { fraud_confirmed: { merchants: 1, share: 0.5, normal_share: 0.333 } },
        last_30_days: {
          other_merchants: 1,
          of_them_new_accounts: 1,
          in_last_24_hours: { other_merchants: 0, of_them_new_accounts: 0 },
          in_last_30_minutes: { other_merchants: 0, of_them_new_accounts: 0 },
        },
      },
    });

    const log = await (await call("GET", `/v1/decisions/${decision.decision_id}`)).json();
    expect(log.subject).toEqual({ type: "merchant", id: "m1" });
    expect(log.context.pending_action.usd).toBe(4200);
    expect((await call("GET", `/v1/decisions/${decision.decision_id}`, undefined, "key_b")).status).toBe(404);
  });

  it("counts links only through the entity types the action names", async () => {
    await call("PUT", "/v1/actions/payout", { ...payout, context: { linkTypes: ["device"] } });
    await track([
      event("order", "2026-10-01T09:00:00Z", { merchant: "m1", device: "d1", courier: "c1" }),
      event("order", "2026-10-02T09:00:00Z", { merchant: "m2", device: "d1", courier: "c1" }),
    ]);
    await call("POST", "/v1/labels", { batch: [{ entity: { type: "courier", id: "c1" }, label: "reported" }] });
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1", device: "d1", courier: "c1" } });
    expect((seen[0]!.context as any).linked_entities).toEqual({
      "device d1": {
        first_seen: "2026-10-01T09:00:00",
        other_merchants: 1,
        last_30_days: {
          other_merchants: 1,
          of_them_new_accounts: 1,
          in_last_24_hours: { other_merchants: 0, of_them_new_accounts: 0 },
          in_last_30_minutes: { other_merchants: 0, of_them_new_accounts: 0 },
        },
      },
      "courier c1": { labels: ["reported"] },
    });
  });

  it("reports concentration in the recent window against the normal share", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    const batch = [];
    // A busy cash machine: 40 merchants over the year, none of them labelled.
    for (let i = 0; i < 40; i++)
      batch.push(event("cash_out", `2026-0${1 + (i % 8)}-1${i % 9}T12:00:00Z`, { merchant: `old_${i}`, atm: "atm_1" }));
    // Tonight: five new merchants at the same machine within twenty minutes, three already labelled.
    for (let i = 0; i < 5; i++)
      batch.push(event("cash_out", `2026-10-06T13:4${i}:00Z`, { merchant: `ring_${i}`, atm: "atm_1" }));
    await track(batch);
    await call("POST", "/v1/labels", {
      batch: [0, 1, 2].map((i) => ({ entity: { type: "merchant", id: `ring_${i}` }, label: "mule_confirmed" })),
    });

    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1", atm: "atm_1" } });
    expect((seen[0]!.context as any).linked_entities["atm atm_1"]).toEqual({
      first_seen: "2026-01-10T12:00:00",
      other_merchants: 45,
      other_merchants_by_label: { mule_confirmed: { merchants: 3, share: 0.067, normal_share: 0.067 } },
      last_30_days: {
        other_merchants: 5,
        of_them_new_accounts: 5,
        in_last_24_hours: { other_merchants: 5, of_them_new_accounts: 5 },
        in_last_30_minutes: { other_merchants: 5, of_them_new_accounts: 5 },
        by_label: { mule_confirmed: { merchants: 3, share: 0.6, normal_share: 0.067 } },
      },
    });
  });

  it("decides as of a past moment when given ts", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    await track([
      event("login", "2026-09-01T09:00:00Z", { merchant: "m1" }),
      event("login", "2026-09-20T09:00:00Z", { merchant: "m1" }),
    ]);
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1" }, ts: "2026-09-10T00:00:00Z" });
    const context = seen[0]!.context as any;
    expect(context.recent_events).toHaveLength(1);
    expect(context.pending_action.requested_at).toBe("2026-09-10T00:00:00");
  });

  it("does not show a label from after the moment it decides as of", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    await track([event("login", "2026-09-01T09:00:00Z", { merchant: "m1", device: "d1" })]);
    await call("PUT", "/v1/objects", { batch: [{ type: "device", id: "d1", properties: { os: "android" } }] });
    await call("POST", "/v1/labels", {
      batch: [
        { entity: { type: "merchant", id: "m1" }, label: "watch", ts: "2026-09-05T00:00:00Z" },
        { entity: { type: "merchant", id: "m1" }, label: "fraud_confirmed", ts: "2026-09-15T00:00:00Z" },
        { entity: { type: "device", id: "d1" }, label: "emulator", ts: "2026-09-15T00:00:00Z" },
      ],
    });
    await call("POST", "/v1/decide", {
      action: "payout",
      entities: { merchant: "m1", device: "d1" },
      ts: "2026-09-10T00:00:00Z",
    });
    const context = seen[0]!.context as any;
    expect(context.subject.labels).toEqual(["watch"]);
    expect(context.linked_entities["device d1"].labels).toBeUndefined();

    await call("POST", "/v1/decide", {
      action: "payout",
      entities: { merchant: "m1", device: "d1" },
      ts: "2026-09-20T00:00:00Z",
    });
    const later = seen[1]!.context as any;
    expect(later.subject.labels).toEqual(["watch", "fraud_confirmed"]);
    expect(later.linked_entities["device d1"].labels).toEqual(["emulator"]);
  });

  it("applies the action's reasons and policy rules", async () => {
    await call("PUT", "/v1/actions/payout", {
      ...payout,
      reasons: {
        new_bank_account: "The payout goes to a bank account added recently",
        spike: "Sales are far above usual",
      },
      policy: { rules: [{ id: "new_account_and_spike", allOf: ["new_bank_account", "spike"], outcome: "review" }] },
    });
    answer = {
      hold: { type: "noul", value: false, probability: 0.2 },
      reasons: { type: "multi_choice", values: [], probabilities: { new_bank_account: 0.9, spike: 0.8 } },
    };
    const decision = await (
      await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "new" } })
    ).json();
    expect(decision).toMatchObject({
      decision: "review",
      risk_score: 20,
      reasons: ["new_bank_account", "spike"],
      rules: ["new_account_and_spike"],
    });
    expect((seen[0]!.context as any).subject.first_seen).toBe("never");
  });

  it("answers 502 when the model cannot be reached", async () => {
    const { GraysonError } = await import("@kairos/core");
    const failing = createApp({
      repos: createRepositories(database.db),
      environments: environmentsRepository(database.db),
      accounts: tenancyRepository(database.db),
      decider: async () => {
        throw new GraysonError("Grayson returned 503", 503);
      },
    });
    const put = (path: string, body: unknown) =>
      failing.request(path, {
        method: path.includes("actions") ? "PUT" : "POST",
        headers: { Authorization: "Bearer key_a" },
        body: JSON.stringify(body),
      });
    await put("/v1/actions/payout", payout);
    const response = await put("/v1/decide", { action: "payout", entities: { merchant: "m1" } });
    expect(response.status).toBe(502);
    expect((await response.json()).error.type).toBe("model_unavailable");
  });
});

describe("an event that starts a decision", () => {
  const request = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: "payout_requested",
    ts: "2026-10-06T13:59:00Z",
    entities: { merchant: "m1", bank_account: "ba_7" },
    properties: { usd: 4200 },
    ...extra,
  });

  it("stores the event and decides in one call, with the event as the pending action", async () => {
    await call("PUT", "/v1/actions/payout", { ...payout, trigger: "payout_requested" });
    await track([event("login", "2026-10-06T13:00:00Z", { merchant: "m1", device: "d1" })]);
    answer = { hold: { type: "noul", value: true, probability: 0.7 } };

    const response = await call("POST", "/v1/events/decide", request("evt_payout_1"));
    expect(response.status).toBe(200);
    const decision = await response.json();
    expect(decision).toMatchObject({
      decision: "review",
      risk_score: 70,
      action: "payout@1",
      event_id: "evt_payout_1",
    });

    const context = seen[0]!.context as any;
    expect(context.pending_action).toEqual({
      usd: 4200,
      bank_account: "ba_7",
      type: "payout",
      requested_at: "2026-10-06T13:59:00",
    });
    // The request is the pending action, not also an event in the history.
    expect(context.recent_events.map((e: any) => e.type)).toEqual(["login"]);
    // But it is stored: the next decision about this merchant sees it.
    const entity = await (await call("GET", "/v1/entities/merchant/m1")).json();
    expect(entity.events.map((e: any) => e.type)).toEqual(["payout_requested", "login"]);
    expect((await (await call("GET", `/v1/decisions/${decision.decision_id}`)).json()).event_id).toBe("evt_payout_1");
  });

  it("returns the same decision when the same event is sent again", async () => {
    await call("PUT", "/v1/actions/payout", { ...payout, trigger: "payout_requested" });
    const first = await (await call("POST", "/v1/events/decide", request("evt_retry"))).json();
    const second = await (await call("POST", "/v1/events/decide", request("evt_retry"))).json();
    expect(second.decision_id).toBe(first.decision_id);
    expect(seen).toHaveLength(1);
  });

  it("does not decide for an event in a batch, or for an event type that triggers nothing", async () => {
    await call("PUT", "/v1/actions/payout", { ...payout, trigger: "payout_requested" });
    await track([request("evt_batch")]);
    expect(seen).toHaveLength(0);

    const none = await call("POST", "/v1/events/decide", request("evt_other", { type: "refund_requested" }));
    expect(none.status).toBe(404);
    expect((await none.json()).error.type).toBe("no_trigger");
    const noSubject = await call("POST", "/v1/events/decide", request("evt_nosub", { entities: { user: "u1" } }));
    expect(noSubject.status).toBe(400);
  });

  it("lets one event type start one action only", async () => {
    await call("PUT", "/v1/actions/payout", { ...payout, trigger: "payout_requested" });
    const clash = await call("PUT", "/v1/actions/second", { ...payout, trigger: "payout_requested" });
    expect(clash.status).toBe(400);
    expect((await clash.json()).error.message).toContain('already starts the action "payout"');
    // Changing the same action keeps its trigger.
    expect(
      (await call("PUT", "/v1/actions/payout", { ...payout, hold: "Hold this payout?", trigger: "payout_requested" }))
        .status,
    ).toBe(200);
  });
});

describe("records with stages", () => {
  const stage = (
    id: string,
    ts: string,
    status: string,
    properties: Record<string, unknown> = {},
    universal = "txn_1",
  ) => ({
    id,
    type: "transaction",
    ts,
    entities: { merchant: "m1", counterparty: "cp_9" },
    properties,
    universal_id: universal,
    status,
  });

  it("stores every stage and shows a decision one record with its latest state", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    await track([
      stage("e1", "2026-10-01T10:00:00Z", "pending", { usd: 500, channel: "card" }),
      stage("e2", "2026-10-01T10:05:00Z", "completed", { settled_usd: 498 }),
      stage("e3", "2026-10-04T09:00:00Z", "disputed", { reason: "not recognised" }),
      stage("e4", "2026-10-02T12:00:00Z", "pending", { usd: 40 }, "txn_2"),
      event("login", "2026-10-03T08:00:00Z", { merchant: "m1" }),
    ]);
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1" } });
    expect((seen[0]!.context as any).recent_events).toEqual([
      {
        usd: 500,
        channel: "card",
        settled_usd: 498,
        reason: "not recognised",
        counterparty: "cp_9",
        status: "disputed",
        status_history: [
          "pending 2026-10-01T10:00:00",
          "completed 2026-10-01T10:05:00",
          "disputed 2026-10-04T09:00:00",
        ],
        ts: "2026-10-01T10:00:00",
        type: "transaction",
      },
      { usd: 40, counterparty: "cp_9", status: "pending", ts: "2026-10-02T12:00:00", type: "transaction" },
      { ts: "2026-10-03T08:00:00", type: "login" },
    ]);

    // As of an earlier moment, the record is in the state it had then.
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1" }, ts: "2026-10-01T10:06:00Z" });
    expect((seen[1]!.context as any).recent_events).toMatchObject([
      { status: "completed", status_history: ["pending 2026-10-01T10:00:00", "completed 2026-10-01T10:05:00"] },
    ]);

    const record = await (await call("GET", "/v1/records/txn_1")).json();
    expect(record.status).toBe("disputed");
    expect(record.stages.map((s: any) => s.status)).toEqual(["pending", "completed", "disputed"]);
    expect((await call("GET", "/v1/records/txn_1", undefined, "key_b")).status).toBe(404);
  });

  it("starts an action only for the statuses its trigger names", async () => {
    await call("PUT", "/v1/actions/payout", { ...payout, trigger: { event: "transaction", status: "pending" } });
    const completed = await call("POST", "/v1/events/decide", stage("e2", "2026-10-01T10:05:00Z", "completed"));
    expect(completed.status).toBe(404);
    expect((await completed.json()).error.message).toContain('"transaction" with status "completed"');
    expect(
      (await call("POST", "/v1/events/decide", stage("e1", "2026-10-01T10:00:00Z", "pending", { usd: 500 }))).status,
    ).toBe(200);

    // A second action may take the other statuses of the same event, but not the same one.
    expect(
      (
        await call("PUT", "/v1/actions/dispute", {
          ...payout,
          trigger: { event: "transaction", status: ["disputed", "returned"] },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("PUT", "/v1/actions/clash", { ...payout, trigger: { event: "transaction", status: ["returned"] } }))
        .status,
    ).toBe(400);
    expect((await call("PUT", "/v1/actions/clash", { ...payout, trigger: "transaction" })).status).toBe(400);
  });

  it("shows a later stage as the pending action with the record's earlier statuses", async () => {
    await call("PUT", "/v1/actions/dispute", { ...payout, trigger: { event: "transaction", status: "disputed" } });
    await track([
      stage("e1", "2026-10-01T10:00:00Z", "pending", { usd: 500 }),
      stage("e2", "2026-10-01T10:05:00Z", "completed"),
    ]);
    await call(
      "POST",
      "/v1/events/decide",
      stage("e3", "2026-10-04T09:00:00Z", "disputed", { reason: "not recognised" }),
    );
    const context = seen[0]!.context as any;
    expect(context.pending_action).toEqual({
      reason: "not recognised",
      counterparty: "cp_9",
      status: "disputed",
      earlier_statuses: ["pending 2026-10-01T10:00:00", "completed 2026-10-01T10:05:00"],
      type: "dispute",
      requested_at: "2026-10-04T09:00:00",
    });
    // The record is the pending action, so it is not also in the history.
    expect(context.recent_events).toEqual([]);
  });
});

describe("console endpoints", () => {
  it("lists and filters decisions, counts outcomes and describes an entity", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    await track([event("login", "2026-09-01T09:00:00Z", { merchant: "m1", device: "d1" })]);
    for (const [merchant, probability, ts] of [
      ["m1", 0.95, "2026-10-01T00:00:00Z"],
      ["m2", 0.1, "2026-10-02T00:00:00Z"],
      ["m1", 0.6, "2026-10-03T00:00:00Z"],
    ] as const) {
      answer = { hold: { type: "noul", value: probability >= 0.5, probability } };
      await call("POST", "/v1/decide", { action: "payout", entities: { merchant }, ts });
    }

    const all = await (await call("GET", "/v1/decisions")).json();
    expect(all.decisions.map((d: any) => d.decision.decision)).toEqual(["review", "approve", "block"]);
    expect(all.decisions[0]).not.toHaveProperty("context");
    const blocked = await (await call("GET", "/v1/decisions?outcome=block&action=payout")).json();
    expect(blocked.decisions).toHaveLength(1);
    const paged = await (await call("GET", "/v1/decisions?limit=1")).json();
    expect(paged.next_before).toBe("2026-10-03T00:00:00.000Z");

    expect(await (await call("GET", "/v1/stats")).json()).toEqual({
      events: 1,
      decisions: 3,
      outcomes: { approve: 1, block: 1, review: 1 },
      actions: 1,
    });
    expect((await (await call("GET", "/v1/stats", undefined, "key_b")).json()).decisions).toBe(0);

    await track([
      event("login", "2026-09-05T09:00:00Z", { merchant: "m2", device: "d1" }),
      event("login", "2026-09-06T09:00:00Z", { merchant: "m_100%", device: "d2" }),
    ]);
    await call("POST", "/v1/labels", { batch: [{ entity: { type: "merchant", id: "m2" }, label: "fraud_confirmed" }] });
    const listed = await (await call("GET", "/v1/entities?type=merchant")).json();
    expect(listed.types).toEqual([
      { type: "merchant", count: 3, events: 3, labelled: 1, last_seen: "2026-09-06T09:00:00.000Z" },
      { type: "device", count: 2, events: 3, labelled: 0, last_seen: "2026-09-06T09:00:00.000Z" },
    ]);
    expect(listed.entities.map((e: any) => [e.id, e.events, e.labels, e.decision?.decision ?? null])).toEqual([
      ["m_100%", 1, [], null],
      ["m2", 1, ["fraud_confirmed"], "approve"],
      ["m1", 1, [], "review"],
    ]);
    expect(
      (await (await call("GET", "/v1/entities?type=merchant&labelled=1")).json()).entities.map((e: any) => e.id),
    ).toEqual(["m2"]);
    expect(
      (await (await call("GET", "/v1/entities?type=merchant&q=0%25")).json()).entities.map((e: any) => e.id),
    ).toEqual(["m_100%"]);
    const overview = await (await call("GET", "/v1/entities")).json();
    expect(overview.types).toHaveLength(2);
    expect(overview.entities).toEqual([]);
    expect((await (await call("GET", "/v1/entities", undefined, "key_b")).json()).types).toEqual([]);

    const o = await (await call("GET", "/v1/overview")).json();
    expect(o).toMatchObject({
      decisions: 3,
      outcomes: { approve: 1, step_up: 0, review: 1, block: 1 },
      entities: 5,
      labelled: 1,
      histogram: [0, 1, 0, 0, 0, 0, 1, 0, 0, 1],
    });
    expect(o.series.bucket).toBe("hour");
    expect(o.series.points).toHaveLength(49);
    expect(o.series.points[0]).toEqual({ t: "2026-10-01T00:00:00.000Z", approve: 0, step_up: 0, review: 0, block: 1 });
    expect(o.by_action).toEqual([{ action: "payout", total: 3, approve: 1, step_up: 0, review: 1, block: 1 }]);
    expect(o.attention.map((d: any) => d.decision.decision)).toEqual(["review", "block"]);
    expect((await (await call("GET", "/v1/overview", undefined, "key_b")).json()).series.points).toEqual([]);

    const entity = await (await call("GET", "/v1/entities/merchant/m1")).json();
    expect(entity.events).toHaveLength(1);
    expect(entity.decisions).toHaveLength(2);
    expect((await call("GET", "/v1/entities/merchant/nobody")).status).toBe(404);
  });
});

describe("usage", () => {
  it("counts events by the day they were received, and decisions with the tokens they read", async () => {
    // NOW is 6 October. These happened long ago and are received today.
    await call("POST", "/v1/events", {
      batch: [
        event("login", "2026-01-01T10:00:00Z", { merchant: "m1" }),
        event("login", "2026-01-02T10:00:00Z", { merchant: "m1" }),
        event("refund", "2026-10-06T09:00:00Z", { merchant: "m2" }),
      ],
    });
    await call("PUT", "/v1/actions/payout", payout);
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1" } });
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m2" } });

    const usage = await (await call("GET", "/v1/usage?days=7")).json();
    expect(usage.since).toBe("2026-09-30T00:00:00.000Z");
    expect(usage.days).toEqual([{ day: "2026-10-06", events: 3, decisions: 2, input_tokens: 2 }]);
    expect(usage.by_action).toEqual([{ action: "payout", decisions: 2, input_tokens: 2 }]);
    expect(usage.by_event_type).toEqual([
      { type: "login", events: 2 },
      { type: "refund", events: 1 },
    ]);
    expect(usage.stored).toEqual({ events: 3, decisions: 2, entities: 2 });
    expect((await (await call("GET", "/v1/usage", undefined, "key_b")).json()).days).toEqual([]);
  });
});

describe("pages of decisions", () => {
  it("returns one page, the total, and the next pages in order", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    for (let i = 0; i < 7; i++) {
      answer = { hold: { type: "noul", value: i % 3 === 0, probability: i % 3 === 0 ? 0.95 : 0.04 } };
      await call("POST", "/v1/decide", {
        action: "payout",
        entities: { merchant: `m${i}` },
        ts: `2026-10-06T1${i}:00:00Z`,
      });
    }
    const page = async (query: string) => (await call("GET", `/v1/decisions?${query}`)).json();
    const first = await page("limit=3");
    expect([first.total, first.decisions.map((d: any) => d.subject.id)]).toEqual([7, ["m6", "m5", "m4"]]);
    expect((await page("limit=3&offset=3")).decisions.map((d: any) => d.subject.id)).toEqual(["m3", "m2", "m1"]);
    const last = await page("limit=3&offset=6");
    expect([last.total, last.decisions.map((d: any) => d.subject.id)]).toEqual([7, ["m0"]]);
    expect((await page("limit=3&offset=30")).decisions).toEqual([]);
    // The total follows the filter, not the page.
    const blocked = await page("outcome=block&limit=2");
    expect([blocked.total, blocked.decisions.map((d: any) => d.subject.id)]).toEqual([3, ["m6", "m3"]]);
    expect((await page("outcome=block&limit=2&offset=2")).decisions.map((d: any) => d.subject.id)).toEqual(["m0"]);
    expect((await (await call("GET", "/v1/decisions", undefined, "key_b")).json()).total).toBe(0);
  });
});

describe("totals in a decision", () => {
  const tx = (id: string, ts: string, direction: string, amount: number, extra: Record<string, unknown> = {}) => ({
    id,
    type: "wallet_transaction",
    ts,
    entities: { user: "u9" },
    properties: { direction, amount },
    ...extra,
  });
  const spend = {
    subject: "user",
    hold: "Should this payment be held?",
    trigger: "wallet_spend_requested",
    context: {
      totals: [
        {
          name: "money_in",
          event: "wallet_transaction",
          sum: "amount",
          where: { direction: "in", status: "completed" },
          window: "7d",
          usual: "90d",
          covers: "amount",
        },
        { name: "money_out", event: "wallet_transaction", sum: "amount", where: { direction: "out" }, window: "24h" },
      ],
    },
  };

  it("calculates them over records and the full window, and shows them to the model", async () => {
    expect((await call("PUT", "/v1/actions/wallet_spend", spend)).status).toBe(200);
    // Forty logins after the money arrived push every transaction out of the recent 30 events.
    const logins = Array.from({ length: 40 }, (_, i) =>
      event(
        "login",
        `2026-10-06T${String(9 + Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}:00Z`,
        { user: "u9" },
      ),
    );
    await call("POST", "/v1/events", {
      batch: [
        tx("t_old", "2026-08-01T10:00:00Z", "in", 300, { status: "completed" }),
        // One record in two stages: counted once, in its latest status.
        tx("t1a", "2026-10-05T08:00:00Z", "in", 9000, { universal_id: "dep_1", status: "pending" }),
        tx("t1b", "2026-10-05T08:05:00Z", "in", 9000, { universal_id: "dep_1", status: "completed" }),
        tx("t2", "2026-10-05T09:00:00Z", "in", 500, { status: "returned" }),
        tx("t3", "2026-10-06T08:00:00Z", "out", 250, { status: "completed" }),
        ...logins,
      ],
    });
    const decided = await call("POST", "/v1/events/decide", {
      id: "spend_1",
      type: "wallet_spend_requested",
      ts: "2026-10-06T13:00:00Z",
      entities: { user: "u9" },
      properties: { amount: 8700 },
    });
    expect(decided.status).toBe(200);

    const context = seen[0]!.context as any;
    expect(context.recent_events.some((e: any) => e.type === "wallet_transaction")).toBe(false);
    expect(context.totals).toEqual({
      money_in_last_7d: { sum: 9000, events: 1 },
      // 300 in the 83 days before: 25.3 for a usual week.
      money_in_last_7d_against_a_usual_7d: "355.7 times",
      share_of_this_action_that_money_in_last_7d_covers: 1,
      money_out_last_24h: { sum: 250, events: 1 },
    });
    expect(Object.keys(context).indexOf("totals")).toBe(Object.keys(context).indexOf("baseline_of_older_events") + 1);
    const logged = await (await call("GET", `/v1/decisions/${(await decided.json()).decision_id}`)).json();
    expect(logged.context.totals.money_in_last_7d).toEqual({ sum: 9000, events: 1 });
  });

  it("applies a rule that compares a total with a number, whatever the model says", async () => {
    const limited = {
      ...spend,
      policy: {
        rules: [
          {
            id: "daily_out_limit",
            allOf: [],
            when: [{ total: "money_out", op: ">=", value: 5000 }],
            outcome: "review",
          },
        ],
      },
    };
    expect((await call("PUT", "/v1/actions/wallet_spend", limited)).status).toBe(200);
    await call("POST", "/v1/events", {
      batch: [
        tx("o1", "2026-10-06T09:00:00Z", "out", 3000, { status: "completed" }),
        tx("o2", "2026-10-06T10:00:00Z", "out", 1900, { status: "completed" }),
      ],
    });
    const ask = async (id: string, ts: string) =>
      (
        await call("POST", "/v1/events/decide", {
          id,
          type: "wallet_spend_requested",
          ts,
          entities: { user: "u9" },
          properties: { amount: 50 },
        })
      ).json();

    // 4,900 out in the last 24 hours: under the limit. The model says nothing is wrong (0.04).
    expect(await ask("spend_a", "2026-10-06T11:00:00Z")).toMatchObject({ decision: "approve", rules: [] });
    await call("POST", "/v1/events", {
      batch: [tx("o3", "2026-10-06T11:30:00Z", "out", 100, { status: "completed" })],
    });
    // 5,000: at the limit.
    expect(await ask("spend_b", "2026-10-06T12:00:00Z")).toMatchObject({
      decision: "review",
      rules: ["daily_out_limit"],
      risk_score: 4,
    });

    const bad = await call("PUT", "/v1/actions/wallet_spend", {
      ...spend,
      policy: { rules: [{ id: "x", allOf: [], when: [{ total: "nothing", op: ">", value: 1 }], outcome: "review" }] },
    });
    expect((await bad.json()).error.message).toContain('"nothing" is not in context.totals');
  });

  it("is a new version when the totals change, and refuses a bad definition", async () => {
    expect((await (await call("PUT", "/v1/actions/wallet_spend", spend)).json()).version).toBe(1);
    const changed = { ...spend, context: { totals: [{ ...spend.context.totals[0], window: "24h", usual: "30d" }] } };
    expect((await (await call("PUT", "/v1/actions/wallet_spend", changed)).json()).version).toBe(2);
    const bad = await call("PUT", "/v1/actions/wallet_spend", {
      ...spend,
      context: { totals: [{ name: "x", event: "e", sum: "amount", window: "soon" }] },
    });
    expect([bad.status, (await bad.json()).error.message]).toEqual([
      400,
      expect.stringContaining("context.totals[0].window"),
    ]);
  });

  it("adds nothing to the context of an action with no totals", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1" } });
    expect(seen[0]!.context).not.toHaveProperty("totals");
  });
});

describe("entity properties from events", () => {
  const ev = (id: string, ts: string, extra: Record<string, unknown>) => ({
    id,
    type: "kyc_completed",
    ts,
    entities: { user: "u1", device: "d1" },
    properties: {},
    ...extra,
  });
  const user = async () => await (await call("GET", "/v1/entities/user/u1")).json();

  it("sets properties on the entities an event names, and keeps them out of the event", async () => {
    const sent = await call("POST", "/v1/events", {
      batch: [
        ev("p1", "2026-10-01T10:00:00Z", {
          set: { user: { kyc_level: "basic", plan: "free" }, device: { os: "ios" } },
          set_once: { user: { opened: "2021-03-04" } },
        }),
      ],
    });
    expect(sent.status).toBe(202);
    const u = await user();
    expect(u.properties).toEqual({ opened: "2021-03-04", kyc_level: "basic", plan: "free" });
    // The entity existed when the event happened, not when it was imported.
    expect(u.first_seen).toBe("2026-10-01T10:00:00.000Z");
    expect(u.events[0]).not.toHaveProperty("set");
    expect((await (await call("GET", "/v1/entities/device/d1")).json()).properties).toEqual({ os: "ios" });
  });

  it("lets the newest event win when events arrive out of order, and sets once only once", async () => {
    await call("POST", "/v1/events", {
      batch: [
        ev("p2", "2026-10-05T10:00:00Z", {
          set: { user: { kyc_level: "full" } },
          set_once: { user: { opened: "2022-01-01" } },
        }),
      ],
    });
    // An older event arrives later: it does not undo the newer value, but it fills what is missing.
    await call("POST", "/v1/events", {
      batch: [
        ev("p1", "2026-10-01T10:00:00Z", {
          set: { user: { kyc_level: "basic", plan: "free" } },
          set_once: { user: { opened: "1999-01-01" } },
        }),
      ],
    });
    expect((await user()).properties).toEqual({ opened: "2022-01-01", kyc_level: "full", plan: "free" });
    // Sending the same event again changes nothing.
    await call("POST", "/v1/events", {
      batch: [ev("p1", "2026-10-01T10:00:00Z", { set: { user: { kyc_level: "basic" } } })],
    });
    expect((await user()).properties.kyc_level).toBe("full");
    // A direct write is a fact as of now, so it replaces the value from a past event.
    await call("PUT", "/v1/entities/user/u1", { properties: { kyc_level: "revoked" } });
    expect((await user()).properties.kyc_level).toBe("revoked");
    // A direct removal is a fact as of now too: an older event does not bring the value back.
    await call("PUT", "/v1/entities/user/u1", { unset: ["plan", "never_set"] });
    expect((await user()).properties).toEqual({ opened: "2022-01-01", kyc_level: "revoked" });
    await call("POST", "/v1/events", {
      batch: [ev("p0", "2026-09-01T10:00:00Z", { set: { user: { plan: "pro" } } })],
    });
    expect((await user()).properties).not.toHaveProperty("plan");
  });

  it("refuses properties for an entity the event does not name", async () => {
    const refused = await call("POST", "/v1/events", {
      batch: [ev("p3", "2026-10-01T10:00:00Z", { set: { merchant: { mcc: 5411 } } })],
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toContain('names no "merchant" entity');
  });

  it("filters and sorts a list of entities", async () => {
    await call("PUT", "/v1/entities/merchant/m1", { properties: { country: "GB", mcc: 5411, verified: true } });
    await call("PUT", "/v1/entities/merchant/m2", { properties: { country: "US", mcc: 5812, verified: false } });
    await call("PUT", "/v1/entities/merchant/m3", { properties: { country: "gb", name: "Corner Coffee" } });
    await call("POST", "/v1/events", {
      batch: [
        { id: "f1", type: "card_payment", ts: "2026-10-06T13:00:00Z", entities: { merchant: "m1" }, properties: {} },
        { id: "f2", type: "card_payment", ts: "2026-10-06T13:30:00Z", entities: { merchant: "m1" }, properties: {} },
        { id: "f3", type: "card_payment", ts: "2026-09-01T10:00:00Z", entities: { merchant: "m2" }, properties: {} },
      ],
    });
    await call("POST", "/v1/labels", {
      batch: [
        { entity: { type: "merchant", id: "m2" }, label: "fraud_confirmed" },
        { entity: { type: "merchant", id: "m2" }, label: "watch" },
      ],
    });
    await call("PUT", "/v1/actions/onboard", {
      subject: "merchant",
      hold: "Hold this merchant?",
      reasons: { a: "Reason a is present", b: "Reason b is present" },
    });
    answer = { hold: { type: "noul", value: true, probability: 0.97 } };
    await call("POST", "/v1/decide", { action: "onboard", entities: { merchant: "m2" } });

    const ids = async (query: string) =>
      (await (await call("GET", `/v1/entities?type=merchant&${query}`)).json()).entities.map((e: any) => e.id);
    expect(await ids("label=fraud_confirmed")).toEqual(["m2"]);
    expect(await ids("label=fraud")).toEqual([]); // a whole label, not a part of one
    expect(await ids("label=*")).toEqual(["m2"]);
    expect((await ids("label=!")).sort()).toEqual(["m1", "m3"]);
    expect(await ids("outcome=block")).toEqual(["m2"]);
    expect((await ids("outcome=none")).sort()).toEqual(["m1", "m3"]);
    expect(await ids("risk_min=90")).toEqual(["m2"]);
    expect(await ids("active=24h")).toEqual(["m1"]);
    expect((await ids("prop=country:eq:GB")).sort()).toEqual(["m1", "m3"]);
    expect(await ids("prop=country:ne:GB")).toEqual(["m2"]);
    expect(await ids("prop=mcc:gt:5500")).toEqual(["m2"]);
    expect(await ids("prop=verified:eq:true")).toEqual(["m1"]);
    expect(await ids("prop=name:contains:coffee")).toEqual(["m3"]);
    expect((await ids("prop=name:missing")).sort()).toEqual(["m1", "m2"]);
    expect(await ids("prop=country:eq:GB&prop=mcc:exists")).toEqual(["m1"]);
    expect(await ids("sort=events")).toEqual(["m1", "m2", "m3"]);
    expect((await ids("sort=risk"))[0]).toBe("m2");
    expect((await call("GET", "/v1/entities?type=merchant&prop=country")).status).toBe(400);
    // A property name is a value, not SQL.
    expect(await ids(`prop=${encodeURIComponent(`x") OR 1=1 --`)}:exists`)).toEqual([]);
    // Pages: the total follows the filter, and the offset moves through the same order.
    const page = async (query: string) => (await call("GET", `/v1/entities?type=merchant&${query}`)).json();
    expect([
      (await page("limit=2&sort=events")).total,
      (await page("limit=2&sort=events")).entities.map((e: any) => e.id),
    ]).toEqual([3, ["m1", "m2"]]);
    expect((await page("limit=2&offset=2&sort=events")).entities.map((e: any) => e.id)).toEqual(["m3"]);
    expect((await page("label=!&limit=1")).total).toBe(2);
    expect((await page("limit=2&offset=9")).entities).toEqual([]);
    const listed = (await (await call("GET", "/v1/entities?type=merchant&label=watch")).json()).entities[0];
    expect(listed.properties).toEqual({ country: "US", mcc: 5812, verified: false });
  });

  it("reports the shape of a type from the stored data", async () => {
    await call("PUT", "/v1/entities/merchant/m1", { properties: { country: "GB", mcc: 5411, verified: true } });
    await call("PUT", "/v1/entities/merchant/m2", { properties: { country: "US", mcc: "5812" } });
    await call("POST", "/v1/events", {
      batch: [
        {
          id: "s1",
          type: "card_payment",
          ts: "2026-10-01T10:00:00Z",
          entities: { user: "u1", merchant: "m1" },
          properties: {},
        },
        {
          id: "s2",
          type: "card_payment",
          ts: "2026-10-01T11:00:00Z",
          entities: { user: "u2", merchant: "m1" },
          properties: {},
        },
        { id: "s3", type: "refund", ts: "2026-10-01T12:00:00Z", entities: { merchant: "m2" }, properties: {} },
      ],
    });
    await call("POST", "/v1/labels", { batch: [{ entity: { type: "merchant", id: "m2" }, label: "fraud_confirmed" }] });

    const shape = await (await call("GET", "/v1/entity-types/merchant/shape")).json();
    expect(shape).toMatchObject({ type: "merchant", with_properties: 2, sampled: 2 });
    expect(shape.properties.map((p: any) => [p.name, p.seen, p.types])).toEqual([
      ["country", 2, ["string"]],
      ["mcc", 2, ["number", "string"]],
      ["verified", 1, ["boolean"]],
    ]);
    expect(shape.events).toEqual([
      { type: "card_payment", count: 2 },
      { type: "refund", count: 1 },
    ]);
    expect(shape.labels).toEqual([{ label: "fraud_confirmed", count: 1 }]);
    // A type with no data has an empty shape, and another project's data is not read.
    expect(await (await call("GET", "/v1/entity-types/branch/shape")).json()).toEqual({
      type: "branch",
      with_properties: 0,
      sampled: 0,
      properties: [],
      events: [],
      labels: [],
    });
    expect(
      (await (await call("GET", "/v1/entity-types/merchant/shape", undefined, "key_b")).json()).properties,
    ).toEqual([]);
  });

  it("defines an entity type, and lists it before anything of that type exists", async () => {
    const definition = {
      description: "A business that takes payments",
      properties: { country: "Where it is registered" },
      link: true,
    };
    expect(await (await call("PUT", "/v1/entity-types/merchant", definition)).json()).toEqual({
      ...definition,
      type: "merchant",
    });
    expect(await (await call("GET", "/v1/entity-types/merchant")).json()).toEqual({ ...definition, type: "merchant" });
    expect((await (await call("GET", "/v1/entity-types")).json()).types).toEqual([
      {
        type: "merchant",
        count: 0,
        events: 0,
        labelled: 0,
        last_seen: null,
        definition: { ...definition, type: "merchant" },
      },
    ]);
    expect((await call("GET", "/v1/entity-types/merchant", undefined, "key_b")).status).toBe(404);

    const bad = await call("PUT", "/v1/entity-types/merchant", { link: "yes", properties: { "bad name": "" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/link must be true or false.*bad name/);
  });

  it("creates an entity directly, and lists it with no events", async () => {
    const created = await (await call("PUT", "/v1/entities/merchant/m_new", { properties: { country: "PT" } })).json();
    expect(created).toMatchObject({ type: "merchant", id: "m_new", properties: { country: "PT" } });
    await call("PUT", "/v1/entities/merchant/m_new", { properties: { category: "bakery" } });
    await track([event("order", "2026-09-01T09:00:00Z", { merchant: "m_old" })]);
    await call("POST", "/v1/labels", { batch: [{ entity: { type: "merchant", id: "m_label_only" }, label: "watch" }] });

    const listed = await (await call("GET", "/v1/entities?type=merchant")).json();
    expect(listed.types).toEqual([
      { type: "merchant", count: 3, events: 1, labelled: 1, last_seen: "2026-09-01T09:00:00.000Z" },
    ]);
    // Created now, so it sorts above the entity whose last event was in September.
    expect(listed.entities.map((e: any) => [e.id, e.events, e.last_seen])).toEqual([
      ["m_new", 0, null],
      ["m_old", 1, "2026-09-01T09:00:00.000Z"],
      ["m_label_only", 0, null],
    ]);
    expect(listed.entities[0].first_seen).toBe(NOW.toISOString());
    expect((await (await call("GET", "/v1/entities/merchant/m_new")).json()).properties).toEqual({
      country: "PT",
      category: "bakery",
    });
    expect((await (await call("GET", "/v1/entities?type=merchant&q=new")).json()).entities).toHaveLength(1);
  });

  it("accepts any kind or none, and keeps the kind out of what the model sees", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    await call("PUT", "/v1/entity-types/merchant", { kind: "business" });
    await call("PUT", "/v1/entity-types/atm", { kind: "place" });
    expect((await call("PUT", "/v1/entity-types/coupon", { kind: "voucher" })).status).toBe(200); // a kind Kairos does not know
    expect((await call("PUT", "/v1/entity-types/coupon", { kind: "not a name" })).status).toBe(400);
    expect((await (await call("GET", "/v1/entity-types/atm")).json()).kind).toBe("place");

    await track([
      event("cash_out", "2026-10-01T09:00:00Z", { merchant: "m1", atm: "a1", courier: "k1" }),
      event("cash_out", "2026-10-02T09:00:00Z", { merchant: "m2", atm: "a1", courier: "k1" }),
    ]);
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1", atm: "a1", courier: "k1" } });
    const context = seen[0]!.context as any;
    // A type with a kind and a type nobody defined give the model the same shape.
    expect(context.subject).not.toHaveProperty("kind");
    expect(Object.keys(context.linked_entities["atm a1"])).toEqual(Object.keys(context.linked_entities["courier k1"]));
  });

  it("does not link through an entity type defined with link: false", async () => {
    await call("PUT", "/v1/actions/payout", payout);
    await call("PUT", "/v1/entity-types/shop", { description: "A shop many unrelated merchants supply", link: false });
    await track([
      event("order", "2026-10-01T09:00:00Z", { merchant: "m1", shop: "s1", device: "d1" }),
      event("order", "2026-10-02T09:00:00Z", { merchant: "m2", shop: "s1", device: "d1" }),
    ]);
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1", shop: "s1", device: "d1" } });
    expect(Object.keys((seen[0]!.context as any).linked_entities)).toEqual(["device d1"]);

    // An action that names its link types has the last word.
    await call("PUT", "/v1/actions/payout", { ...payout, context: { linkTypes: ["shop"] } });
    await call("POST", "/v1/decide", { action: "payout", entities: { merchant: "m1", shop: "s1", device: "d1" } });
    expect(Object.keys((seen[1]!.context as any).linked_entities)).toEqual(["shop s1"]);
  });
});

describe("objects and labels", () => {
  it("merges properties and returns labels", async () => {
    await call("PUT", "/v1/objects", {
      batch: [{ type: "device", id: "d1", properties: { os: "android", rooted: false } }],
    });
    await call("PUT", "/v1/objects", { batch: [{ type: "device", id: "d1", properties: { rooted: true } }] });
    await call("POST", "/v1/labels", { batch: [{ entity: { type: "device", id: "d1" }, label: "emulator" }] });
    const object = await (await call("GET", "/v1/objects/device/d1")).json();
    expect(object.properties).toEqual({ os: "android", rooted: true });
    expect(object.labels.map((l: any) => l.label)).toEqual(["emulator"]);
    expect((await call("GET", "/v1/objects/device/d1", undefined, "key_b")).status).toBe(404);
  });
});

describe("sessions", () => {
  const action = {
    subject: "user",
    hold: "Should this withdrawal be held?",
    trigger: "withdrawal_requested",
    context: { totals: [{ name: "money_out", event: "transfer", sum: "usd", window: "session" }] },
    policy: {
      rules: [{ id: "session_drain", when: [{ total: "money_out", op: ">=", value: 400 }], outcome: "block" }],
    },
  };
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  const inSession = (
    id: string,
    minutesAgo: number,
    type: string,
    session: string | undefined,
    user = "u1",
    properties = {},
  ) => ({
    id,
    type,
    ts: at(minutesAgo),
    entities: { user },
    properties,
    ...(session ? { session } : {}),
  });

  beforeEach(async () => {
    expect((await call("PUT", "/v1/actions/withdrawal", action)).status).toBe(200);
    await track([
      inSession("s1", 2000, "login", "old"),
      inSession("s2", 6, "login", "now"),
      inSession("s3", 5, "password_changed", "now"),
      inSession("s4", 4, "transfer", "now", "u1", { usd: 450 }),
      inSession("s5", 3, "transfer", undefined, "u1", { usd: 9000 }),
      inSession("s6", 2, "login", "now", "u2"),
    ]);
  });

  it("shows a decision what happened in its session, and who else was in it", async () => {
    const decided = await (
      await call("POST", "/v1/decide", {
        action: "withdrawal",
        entities: { user: "u1" },
        properties: { usd: 50 },
        session: "now",
      })
    ).json();
    const context = seen[0]!.context as any;
    expect(context.this_session).toEqual({
      started: at(6).slice(0, 19),
      started_before_this_action: "6 minutes",
      events: 4,
      steps: ["+0:00 login", "+1:00 password_changed", "+2:00 transfer", "+4:00 login"],
      other_users_in_this_session: 1,
    });
    // The total for the session counts this user's events in this session, and nothing else.
    expect(context.totals).toEqual({ money_out_this_session: { sum: 450, events: 1 } });
    expect(decided).toMatchObject({ decision: "block", rules: ["session_drain"] });
    expect((await (await call("GET", `/v1/decisions/${decided.decision_id}`)).json()).session).toBe("now");
  });

  it("decides as before for a request with no session, or a session with no events", async () => {
    for (const session of [undefined, "never_seen"]) {
      const decided = await (
        await call("POST", "/v1/decide", {
          action: "withdrawal",
          entities: { user: "u1" },
          properties: {},
          ...(session ? { session } : {}),
        })
      ).json();
      const context = seen.at(-1)!.context as any;
      expect(context).not.toHaveProperty("this_session");
      // No session: no total for it. A session that has no events yet: a total of nothing.
      expect(context.totals).toEqual(session ? { money_out_this_session: { sum: 0, events: 0 } } : undefined);
      expect(decided).toMatchObject({ decision: "approve", rules: [] });
    }
  });

  it("takes the session of an event that starts a decision, and leaves that event out of it", async () => {
    const decided = await (
      await call("POST", "/v1/events/decide", {
        ...inSession("w1", 0, "withdrawal_requested", "now", "u1", { usd: 10 }),
      })
    ).json();
    expect((seen[0]!.context as any).this_session.steps).toEqual([
      "+0:00 login",
      "+1:00 password_changed",
      "+2:00 transfer",
      "+4:00 login",
    ]);
    expect(decided.decision).toBe("block");
  });

  it("answers for a session: its events, its entities and its decisions, inside one workspace", async () => {
    await call("POST", "/v1/decide", {
      action: "withdrawal",
      entities: { user: "u1" },
      properties: {},
      session: "now",
    });
    const session = await (await call("GET", "/v1/sessions/now")).json();
    expect(session).toMatchObject({
      id: "now",
      started: at(6),
      last_seen: NOW.toISOString(),
      entities: { user: ["u1", "u2"] },
    });
    expect(session.events.map((e: any) => e.id)).toEqual(["s2", "s3", "s4", "s6"]);
    expect(session.events[0].session).toBe("now");
    expect(session.decisions.map((d: any) => d.session)).toEqual(["now"]);
    expect((await call("GET", "/v1/sessions/nothing")).status).toBe(404);
    expect((await call("GET", "/v1/sessions/now", undefined, "key_b")).status).toBe(404);
    expect((await (await call("GET", "/v1/decisions?session=now")).json()).total).toBe(1);
  });

  it("lists sessions, most recently active first, with what was decided in each", async () => {
    await call("POST", "/v1/decide", {
      action: "withdrawal",
      entities: { user: "u1" },
      properties: {},
      session: "now",
    });
    const all = await (await call("GET", "/v1/sessions")).json();
    expect(all).toMatchObject({ total: 2, next_offset: null });
    expect(all.sessions).toEqual([
      {
        id: "now",
        started: at(6),
        last_seen: at(2),
        events: 4,
        decisions: 1,
        outcome: "block",
        risk_score: 4,
        entities: { user: ["u1", "u2"] },
      },
      {
        id: "old",
        started: at(2000),
        last_seen: at(2000),
        events: 1,
        decisions: 0,
        outcome: null,
        risk_score: null,
        entities: { user: ["u1"] },
      },
    ]);
    const ids = async (query: string) =>
      (await (await call("GET", `/v1/sessions?${query}`)).json()).sessions.map((s: any) => s.id);
    expect(await ids("q=OL")).toEqual(["old"]);
    expect(await ids("outcome=any")).toEqual(["now"]);
    expect(await ids("outcome=block")).toEqual(["now"]);
    expect(await ids("outcome=approve")).toEqual([]);
    expect(await ids("limit=1&offset=1")).toEqual(["old"]);
    expect((await (await call("GET", "/v1/sessions?limit=1")).json()).next_offset).toBe(1);
    expect((await (await call("GET", "/v1/sessions", undefined, "key_b")).json()).total).toBe(0);
  });

  it("lists the sessions of an entity, most recent first", async () => {
    const user = await (await call("GET", "/v1/entities/user/u1")).json();
    expect(user.sessions).toEqual([
      { id: "now", started: at(6), last_seen: at(4), events: 3 },
      { id: "old", started: at(2000), last_seen: at(2000), events: 1 },
    ]);
  });
});
