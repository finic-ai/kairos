import { describe, expect, it } from "vitest";
import { applyMapping, parsePath, readPath, validateMapping, type WebhookMapping } from "../src";

const AT = "2026-10-15T12:00:00.000Z";

/** The mapping of the design note, section 7.1. */
const stripe: WebhookMapping = {
  rules: [
    {
      name: "Payment",
      match: { type: ["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.processing"] },
      event: {
        id: "$.id",
        type: "transaction",
        ts: { path: "$.created", format: "unix_seconds" },
        entities: { user: "$.data.object.metadata.user_id", stripe_customer: "$.data.object.customer" },
        universal_id: "$.data.object.id",
        status: {
          path: "$.type",
          values: {
            "payment_intent.succeeded": "completed",
            "payment_intent.payment_failed": "failed",
            "payment_intent.processing": "pending",
          },
        },
        properties: {
          amount_minor: "$.data.object.amount",
          currency: "$.data.object.currency",
          payment_method: "$.data.object.payment_method_types[0]",
        },
      },
    },
    {
      name: "Dispute",
      match: { type: "charge.dispute.created" },
      event: {
        id: "$.id",
        type: "dispute_opened",
        ts: { path: "$.created", format: "unix_seconds" },
        entities: { user: "$.data.object.metadata.user_id" },
        properties: { reason: "$.data.object.reason", amount_minor: "$.data.object.amount" },
      },
      label: { entity: "user", label: "chargeback", properties: { reason: "$.data.object.reason" } },
    },
  ],
};

const payment = {
  id: "evt_1",
  type: "payment_intent.succeeded",
  created: 1792065600,
  data: {
    object: {
      id: "pi_9",
      amount: 9500,
      currency: "usd",
      customer: "cus_N",
      payment_method_types: ["card", "link"],
      metadata: { user_id: "user_42" },
    },
  },
};

describe("paths", () => {
  it("reads names, quoted names and positions, and nothing else", () => {
    expect(parsePath("$.data.object['a name'][0]")).toEqual({ root: "$", steps: ["data", "object", "a name", 0] });
    expect(parsePath('$$["x.y"]')).toEqual({ root: "$$", steps: ["x.y"] });
    expect(parsePath("$")).toEqual({ root: "$", steps: [] });
    for (const bad of ["data.id", "$.a[*]", "$..a", "$.a[?(@.b)]", "$.a[", "$.a['b]"])
      expect(parsePath(bad), bad).toBeNull();
    expect(readPath({ a: [{ b: 1 }] }, ["a", 0, "b"])).toBe(1);
    expect(readPath({ a: [{ b: 1 }] }, ["a", "0"])).toBeUndefined();
    expect(readPath({ a: null }, ["a", "b"])).toBeUndefined();
    expect(parsePath("$.events[-1].token")).toEqual({ root: "$", steps: ["events", -1, "token"] });
    expect(readPath({ a: [1, 2, 3] }, ["a", -1])).toBe(3);
    expect(readPath({ a: [1, 2, 3] }, ["a", -2])).toBe(2);
    expect(readPath({ a: [1] }, ["a", -2])).toBeUndefined();
    expect(readPath({ a: [] }, ["a", -1])).toBeUndefined();
  });
});

describe("applyMapping", () => {
  it("turns a payment into a stage of a record", () => {
    const result = applyMapping(stripe, { body: payment }, AT);
    expect(result).toMatchObject({ outcome: "mapped", matched: ["Payment"], problems: [], labels: [] });
    expect(result.events).toEqual([
      {
        id: "evt_1",
        type: "transaction",
        ts: "2026-10-15T12:00:00.000Z",
        entities: { user: "user_42", stripe_customer: "cus_N" },
        universal_id: "pi_9",
        status: "completed",
        properties: { amount_minor: 9500, currency: "usd", payment_method: "card" },
      },
    ]);
  });

  it("makes an event and a label from a dispute", () => {
    const dispute = {
      id: "evt_2",
      type: "charge.dispute.created",
      created: 1792065600,
      data: { object: { reason: "fraudulent", amount: 9500, metadata: { user_id: "user_42" } } },
    };
    const result = applyMapping(stripe, { body: dispute }, AT);
    expect(result.events.map((e) => e.type)).toEqual(["dispute_opened"]);
    expect(result.labels).toEqual([
      {
        entity: { type: "user", id: "user_42" },
        label: "chargeback",
        ts: "2026-10-15T12:00:00.000Z",
        properties: { reason: "fraudulent" },
      },
    ]);
  });

  it("ignores what no rule matches, unless told to fail", () => {
    expect(applyMapping(stripe, { body: { id: "evt_3", type: "customer.updated" } }, AT)).toMatchObject({
      outcome: "ignored",
      events: [],
      problems: [],
    });
    expect(applyMapping({ ...stripe, unmatched: "fail" }, { body: { type: "customer.updated" } }, AT).outcome).toBe(
      "failed",
    );
  });

  it("stores nothing from a delivery when a matching rule fails, and says why", () => {
    const noId = applyMapping(stripe, { body: { ...payment, id: undefined } }, AT);
    expect(noId).toMatchObject({
      outcome: "failed",
      events: [],
      problems: ['Rule "Payment": event.id found no value'],
    });
    const badTime = applyMapping(stripe, { body: { ...payment, created: "soon" } }, AT);
    expect(badTime.outcome).toBe("failed");
    expect(badTime.problems[0]).toContain("event.ts");
    const noEntity = applyMapping(stripe, { body: { ...payment, data: { object: { id: "pi_9" } } } }, AT);
    expect(noEntity).toMatchObject({ outcome: "no_entity", events: [] });
    expect(noEntity.problems[0]).toContain("names no entity");
  });

  it("leaves out an entity with no value, and keeps the others", () => {
    const body = { ...payment, data: { object: { ...payment.data.object, customer: null } } };
    expect(applyMapping(stripe, { body }, AT).events[0]!.entities).toEqual({ user: "user_42" });
  });

  it("matches on several fields, on a list, and on numbers as text", () => {
    const mapping: WebhookMapping = {
      rules: [
        { match: { type: "x", "data.code": [1, 2] }, event: { id: "$.id", type: "$.type", entities: { user: "$.u" } } },
      ],
    };
    expect(
      applyMapping(mapping, { body: { id: 1, type: "x", data: { code: "2" }, u: 7 } }, AT).events[0],
    ).toMatchObject({ id: "1", type: "x", entities: { user: "7" } });
    expect(applyMapping(mapping, { body: { id: 1, type: "x", data: { code: 3 }, u: 7 } }, AT).outcome).toBe("ignored");
    expect(applyMapping(mapping, { body: { id: 1, type: "y", data: { code: 1 }, u: 7 } }, AT).outcome).toBe("ignored");
  });

  it("matches on a header, whatever the case of its name", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          match: { kind: "order" },
          match_headers: { "X-Topic": ["orders/create", "orders/paid"] },
          event: { id: { path: "$.x-delivery", headers: true }, type: "order", entities: { user: "$.u" } },
        },
      ],
    };
    const body = { kind: "order", u: "u1" };
    expect(
      applyMapping(mapping, { body, headers: { "x-topic": "orders/paid", "X-Delivery": "d_1" } }, AT).events[0],
    ).toMatchObject({ id: "d_1", type: "order" });
    expect(applyMapping(mapping, { body, headers: { "X-Topic": "orders/delete" } }, AT).outcome).toBe("ignored");
    expect(applyMapping(mapping, { body }, AT).outcome).toBe("ignored");
    expect(
      applyMapping(mapping, { body: { ...body, kind: "refund" }, headers: { "x-topic": "orders/paid" } }, AT).outcome,
    ).toBe("ignored");
  });

  it("joins values into one id, and gives nothing when a part is missing", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          event: {
            id: { join: ["$.applicant", "$.type", { path: "$.at" }] },
            type: "check",
            entities: { user: "$.u" },
            properties: { key: { join: ["k", "$.n"], with: "-" } },
          },
        },
      ],
    };
    const body = { applicant: "a1", type: "applicantReviewed", at: "2026-04-30 08:04:23.379", u: "u1", n: 7 };
    expect(applyMapping(mapping, { body }, AT).events[0]).toMatchObject({
      id: "a1:applicantReviewed:2026-04-30 08:04:23.379",
      properties: { key: "k-7" },
    });
    expect(applyMapping(mapping, { body: { ...body, at: undefined } }, AT).problems).toEqual([
      "Rule 1: event.id found no value",
    ]);
  });

  it("reads a time with no zone as UTC, wherever it runs", () => {
    const mapping: WebhookMapping = {
      rules: [{ event: { id: "$.id", type: "t", ts: "$.at", entities: { user: "$.u" } } }],
    };
    const at = (value: string) => applyMapping(mapping, { body: { id: "1", u: "u", at: value } }, AT).events[0]!.ts;
    expect(at("2026-04-30 08:04:23.379")).toBe("2026-04-30T08:04:23.379Z");
    expect(at("2026-04-30T08:04:23")).toBe("2026-04-30T08:04:23.000Z");
    expect(at("2026-04-30T08:04:23-04:00")).toBe("2026-04-30T12:04:23.000Z");
  });

  it("reads a decimal sent as text as a number", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          event: {
            id: "$.id",
            type: "order",
            entities: { user: "$.u" },
            properties: {
              text: { path: "$.text", format: "number" },
              number: { path: "$.number", format: "number" },
              negative: { path: "$.negative", format: "number" },
              word: { path: "$.word", format: "number" },
              missing: { path: "$.missing", format: "number", default: "0.00" },
            },
          },
        },
      ],
    };
    const body = { id: "o1", u: "u1", text: "404.95", number: 12, negative: "-5.10", word: "free" };
    expect(applyMapping(mapping, { body }, AT).events[0]!.properties).toEqual({
      text: 404.95,
      number: 12,
      negative: -5.1,
      missing: 0,
    });
  });

  it("applies each transform", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          event: {
            id: { path: "$.missing", default: "fallback" },
            type: { path: "$.kind", values: { a: "alpha" } },
            ts: { path: "$.ms", format: "unix_ms" },
            entities: { user: "$.user" },
            status: { path: "$.state", values: { ok: "completed" }, default: "unknown" },
            session: { path: "$.x-session", headers: true },
            properties: { at: { path: "$.when", format: "iso" }, constant: 5, flag: true },
          },
        },
      ],
    };
    const event = applyMapping(
      mapping,
      {
        body: { kind: "b", ms: 1792065600000, user: "u1", state: "weird", when: "2026-10-01T00:00:00Z" },
        headers: { "X-Session": "s_1" },
      },
      AT,
    ).events[0]!;
    expect(event).toMatchObject({
      id: "fallback",
      type: "b",
      ts: "2026-10-15T12:00:00.000Z",
      status: "unknown",
      session: "s_1",
      properties: { at: "2026-10-01T00:00:00.000Z", constant: 5, flag: true },
    });
  });

  it("takes every scalar field of an object, except some", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          event: { id: "$.id", type: "t", entities: { user: "$.u" }, properties: { all: "$.obj", except: ["secret"] } },
        },
      ],
    };
    const event = applyMapping(
      mapping,
      { body: { id: "1", u: "u", obj: { a: 1, b: "x", secret: "s", nested: { c: 1 }, list: [1] } } },
      AT,
    ).events[0]!;
    expect(event.properties).toEqual({ a: 1, b: "x" });
  });

  it("runs a rule for each element of a list", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          items: "$.batch",
          match: { "$$.kind": "login" },
          event: { id: "$$.id", type: "login", entities: { user: "$$.user" }, properties: { source: "$.source" } },
        },
      ],
    };
    const result = applyMapping(
      mapping,
      {
        body: {
          source: "idp",
          batch: [
            { id: "a", kind: "login", user: "u1" },
            { id: "b", kind: "logout", user: "u1" },
            { id: "c", kind: "login", user: "u2" },
          ],
        },
      },
      AT,
    );
    expect(result.events.map((e) => [e.id, e.entities.user, e.properties.source])).toEqual([
      ["a", "u1", "idp"],
      ["c", "u2", "idp"],
    ]);
    const many = { batch: Array.from({ length: 501 }, (_, i) => ({ id: String(i), kind: "login", user: "u" })) };
    expect(applyMapping(mapping, { body: many }, AT)).toMatchObject({ outcome: "failed", events: [] });
  });

  it("puts properties on named entities only", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          event: {
            id: "$.id",
            type: "kyc",
            entities: { user: "$.u" },
            set: { user: { kyc: "$.result" }, device: { x: "$.y" } },
          },
        },
      ],
    };
    expect(applyMapping(mapping, { body: { id: "1", u: "u", result: "passed" } }, AT).events[0]!.set).toEqual({
      user: { kyc: "passed" },
    });
  });

  it("puts a label on its own entity when the rule has no event", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          match: { type: "dispute.won" },
          label: { entity: "user", id: "$.user", label: "dispute_won", ts: { path: "$.at", format: "unix_seconds" } },
        },
      ],
    };
    expect(applyMapping(mapping, { body: { type: "dispute.won", user: "u1", at: 1792065600 } }, AT).labels).toEqual([
      { entity: { type: "user", id: "u1" }, label: "dispute_won", ts: "2026-10-15T12:00:00.000Z", properties: {} },
    ]);
    expect(applyMapping(mapping, { body: { type: "dispute.won", at: 1 } }, AT).outcome).toBe("no_entity");
  });
});

describe("lookups", () => {
  it("leaves to the server an entity that the payload does not name", () => {
    const mapping: WebhookMapping = {
      rules: [
        {
          event: {
            id: "$.id",
            type: "dispute",
            entities: { user: { record: "$.pi" }, card: { lookup: { property: "fingerprint", value: "$.fp" } } },
          },
          label: { entity: "user", label: "chargeback" },
        },
      ],
    };
    const result = applyMapping(mapping, { body: { id: "d1", pi: "pi_9", fp: "fp_1" } }, AT);
    expect(result.outcome).toBe("mapped");
    expect(result.events[0]).toMatchObject({
      entities: {},
      lookups: {
        user: { by: "record", record: "pi_9" },
        card: { by: "property", property: "fingerprint", value: "fp_1" },
      },
    });
    expect(result.labels[0]).toEqual({
      entity: { type: "user" },
      lookup: { by: "record", record: "pi_9" },
      label: "chargeback",
      ts: AT,
      properties: {},
    });
    // Nothing to look up with: no entity at all.
    expect(applyMapping(mapping, { body: { id: "d2" } }, AT).outcome).toBe("no_entity");
  });

  it("checks a lookup's shape", () => {
    const problems = validateMapping({
      rules: [
        {
          event: {
            id: "$.id",
            type: "t",
            entities: { user: { lookup: { property: "a b" } }, card: { record: "$.x", extra: 1 } },
          },
        },
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "rules[0].event.entities.user.lookup.property: the name of a property, such as stripe_customer_id",
        "rules[0].event.entities.user.lookup.value: necessary",
        'rules[0].event.entities.card: a record lookup has only "record"',
      ]),
    );
  });
});

describe("validateMapping", () => {
  it("accepts the design's mapping", () => {
    expect(validateMapping(stripe)).toEqual([]);
  });

  it("says what is wrong, in words", () => {
    expect(validateMapping(null)).toEqual(["mapping: must be an object with rules"]);
    expect(validateMapping({ rules: [] })).toEqual(["mapping.rules: must be a list with at least one rule"]);
    const problems = validateMapping({
      unmatched: "drop",
      rules: [
        {},
        { event: { type: "t", entities: {} } },
        { event: { id: "$.a[*]", type: "t", entities: { "bad type": "$.u" }, ts: { path: "$.t", format: "weekday" } } },
        { items: "data", label: { entity: "user", label: "Not A Name" } },
        { event: { id: "$.id", type: "t", entities: { user: "$.u" }, set: { user: { a: "$.b" } } } },
        {
          match_headers: { "x topic": "a" },
          event: { id: "$.id", type: "t", entities: { user: "$.u" }, ts: { path: "$.t", format: "number" } },
        },
        {
          event: {
            id: { join: [] } as never,
            type: { join: ["$.a", { join: ["$.b"] }] } as never,
            entities: { user: "$.u" },
          },
        },
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'mapping.unmatched: must be "ignore" or "fail"',
        "rules[0]: needs an event, a label, or both",
        "rules[1].event.id: necessary, so that a retry stores nothing twice",
        "rules[1].event.entities: name at least one entity",
        'rules[2].event.entities: "bad type" is not an entity type name',
        'rules[2].event.id: "$.a[*]" is not a path this engine reads. Use $.name, $["a name"] or $.list[0]',
        "rules[2].event.ts.format: must be iso, unix_seconds, unix_ms or number",
        "rules[3].items: must be a path such as $.data.list",
        'rules[3].label: the rule\'s event names no "user"; give the label an id',
        'rules[3].label.label: "Not A Name" must be a name such as chargeback',
        "rules[4].event.set: only a source that verifies a signature (hmac, timestamped, stripe or standard) can set entity properties",
        'rules[5].match_headers: "x topic" is not a header name',
        "rules[5].event.ts.format: a time cannot be a number",
        "rules[6].event.id.join: a list of 1 to 10 values",
        "rules[6].event.type.join[1]: a join cannot hold a join",
      ]),
    );
    expect(
      validateMapping(
        { rules: [{ event: { id: "$.id", type: "t", entities: { user: "$.u" }, set: { user: { a: "$.b" } } } }] },
        { allowSet: true },
      ),
    ).toEqual([]);
  });
});
