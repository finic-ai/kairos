import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyPolicy,
  buildBaseline,
  buildContext,
  buildQuestions,
  decide,
  displayName,
  displayOf,
  suggestKind,
  validateAction,
  validateEntity,
  validateEventTemplate,
  type EventTemplate,
  type ActionDefinition,
  type GraysonResponse,
  type KairosEvent,
  type Policy,
} from "../src";

const TEMPLATES = fileURLToPath(new URL("../../../templates/actions/", import.meta.url));
const templates: ActionDefinition[] = readdirSync(TEMPLATES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(TEMPLATES + f, "utf8")));
const WITHDRAWAL_ACTION = templates.find((t) => t.name === "withdrawal")!;

const day = (i: number) => `2026-02-${String(i + 1).padStart(2, "0")}`;

describe("buildBaseline", () => {
  it("returns null for no events", () => {
    expect(buildBaseline([])).toBeNull();
  });

  it("profiles any event type: numbers, categories and high-cardinality fields", () => {
    const events: KairosEvent[] = [];
    for (let i = 0; i < 12; i++) {
      events.push({
        ts: `${day(i)}T08:00`,
        type: "card_payment",
        amount: 10 * (i + 1),
        merchant: `m_${i}`,
        channel: i % 3 ? "pos" : "online",
      });
    }
    const baseline = buildBaseline(events)!;
    expect(baseline.period).toEqual(["2026-02-01T08:00", "2026-02-12T08:00"]);
    expect(baseline.activity_by_hour_band).toEqual({ "06-12h": 12 });
    expect(baseline.event_types.card_payment).toEqual({
      count: 12,
      last: "2026-02-12T08:00",
      fields: {
        amount: { median: 65, max: 120 },
        merchant: { distinct: 12 },
        channel: { values: { pos: 8, online: 4 } },
      },
    });
    expect(baseline.rare_events).toEqual([]);
  });

  it("keeps rare event types and free-text events in full", () => {
    const text =
      "My account manager says I must send funds to their wallet to unlock my profit. How do I raise my limit?";
    const events: KairosEvent[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ ts: `${day(i)}T09:00`, type: "login", device: "d1" })),
      ...Array.from({ length: 4 }, (_, i) => ({
        ts: `${day(i)}T10:00`,
        type: "note",
        text: i === 3 ? text : `short ${i}`,
      })),
      { ts: `${day(6)}T03:00`, type: "two_factor_disabled" },
    ].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const baseline = buildBaseline(events)!;
    expect(baseline.event_types.two_factor_disabled).toEqual({ count: 1, last: `${day(6)}T03:00` });
    expect(baseline.event_types.login!.fields).toEqual({ device: { values: { d1: 5 } } });
    expect(baseline.rare_events.map((e) => e.type)).toEqual(["note", "note", "note", "note", "two_factor_disabled"]);
    expect(baseline.rare_events[3]!.text).toBe(text);
  });
});

describe("buildContext", () => {
  const input = {
    subject: { type: "user", id: "u1", opened: "2024-01-01" },
    events: Array.from({ length: 40 }, (_, i) => ({
      ts: `2026-03-${String(i + 1).padStart(2, "0")}T08:00`,
      type: "login",
    })).reverse(),
    pendingAction: { type: "payout", usd: 500 },
  };

  it("sorts events, keeps the most recent in full and summarises the rest", () => {
    const context = buildContext(input, { recentEvents: 30 });
    expect(context.subject).toEqual(input.subject);
    expect(context.recent_events).toHaveLength(30);
    expect(context.recent_events[0]!.ts).toBe("2026-03-11T08:00");
    expect(context.baseline_of_older_events!.events).toBe(10);
    expect(context).not.toHaveProperty("linked_entities");
  });

  it("has no baseline when every event is recent", () => {
    const context = buildContext({ ...input, events: input.events.slice(0, 5) });
    expect(context.baseline_of_older_events).toBeNull();
    expect(context.recent_events).toHaveLength(5);
  });
});

describe("applyPolicy", () => {
  const policy: Policy = {
    block: 0.9,
    review: 0.5,
    rules: [{ id: "combo", allOf: ["a", "b"], outcome: "step_up" }],
  };

  it("maps the probability to an outcome", () => {
    expect(applyPolicy(policy, 0.95, []).decision).toBe("block");
    expect(applyPolicy(policy, 0.6, []).decision).toBe("review");
    expect(applyPolicy(policy, 0.1, []).decision).toBe("approve");
  });

  it("applies a rule when all its reasons are present, and never lowers a stronger outcome", () => {
    expect(applyPolicy(policy, 0.07, ["a", "b", "c"])).toEqual({ decision: "step_up", rules: ["combo"] });
    expect(applyPolicy(policy, 0.07, ["a"]).decision).toBe("approve");
    expect(applyPolicy(policy, 0.95, ["a", "b"]).decision).toBe("block");
  });
});

describe("actions", () => {
  const payout: ActionDefinition = { name: "payout", subject: "merchant", hold: "Should this payout be held?" };

  it("builds only the questions the definition asks for", () => {
    expect(Object.keys(buildQuestions(payout))).toEqual(["hold"]);
    expect(Object.keys(buildQuestions(WITHDRAWAL_ACTION))).toEqual(["hold", "typology", "reasons"]);
  });

  it("accepts a minimal definition and the withdrawal preset", () => {
    expect(validateAction(payout)).toEqual([]);
    expect(validateAction(WITHDRAWAL_ACTION)).toEqual([]);
  });

  it("reports problems", () => {
    const problems = validateAction({
      name: "bad name",
      subject: "user",
      hold: " ",
      reasons: { only_one: "x" },
      policy: { block: 0.2, review: 0.5, rules: [{ id: "r", allOf: ["missing"], outcome: "step_up" }] },
    });
    expect(problems).toHaveLength(5);
  });

  it("needs a reason threshold that is a number from 0 to 1", () => {
    const withThreshold = (reasonThreshold: unknown) =>
      validateAction({ ...payout, context: { ...payout.context, reasonThreshold } as never });
    expect(withThreshold(0.5)).toEqual([]);
    for (const bad of ["0,5", "0.5", Number.NaN, -0.1, 2, null])
      expect(withThreshold(bad), String(bad)).toEqual(["context.reasonThreshold must be between 0 and 1"]);
  });
});

describe("entity kinds", () => {
  it("suggests a kind from a type name, and nothing when unsure", () => {
    expect(["user", "merchant", "device", "ip", "atm", "bank_account", "email", "passport"].map(suggestKind)).toEqual([
      "person",
      "business",
      "device",
      "network",
      "place",
      "account",
      "contact",
      "document",
    ]);
    expect(suggestKind("claim")).toBeUndefined();
  });

  it("accepts any kind name, known or not, and no kind at all", () => {
    expect(validateEntity({ type: "atm", kind: "place" })).toEqual([]);
    expect(validateEntity({ type: "coupon", kind: "voucher" })).toEqual([]);
    expect(validateEntity({ type: "coupon" })).toEqual([]);
    expect(validateEntity({ type: "coupon", kind: "two words" })).toHaveLength(1);
  });
});

describe("entity display", () => {
  it("takes the icon and the colour of the kind, or of the kind the name suggests, unless the type sets its own", () => {
    expect(displayOf("customer")).toEqual({ icon: "person", color: "blue", fields: [] });
    expect(displayOf("atm", { kind: "place" })).toMatchObject({ icon: "pin", color: "red" });
    expect(displayOf("claim")).toMatchObject({ icon: "tag", color: "gray" });
    expect(displayOf("user", { display: { icon: "business", fields: ["name"] } })).toEqual({
      icon: "business",
      color: "blue",
      fields: ["name"],
    });
  });

  it("names an entity from the display fields it has, and is undefined when it has none", () => {
    const fields = ["first_name", "last_name"];
    expect(displayName(fields, { first_name: "Ada", last_name: "Lovelace" })).toBe("Ada Lovelace");
    expect(displayName(fields, { first_name: "Ada", last_name: "" })).toBe("Ada");
    expect(displayName(fields, { email: "ada@example.com" })).toBeUndefined();
    expect(displayName(undefined, { name: "Ada" })).toBeUndefined();
    expect(displayName(["customer_number"], { customer_number: 42 })).toBe("42");
  });

  it("accepts only the known icons and colours, and up to four property names", () => {
    expect(validateEntity({ type: "user", display: { icon: "person", color: "teal", fields: ["name"] } })).toEqual([]);
    expect(validateEntity({ type: "beneficiary", display: { icon: "arrow_in" } })).toEqual([]);
    expect(validateEntity({ type: "clinic", display: { icon: "hospital" } })).toEqual([]);
    expect(validateEntity({ type: "policyholder", display: { icon: "shield" } })).toEqual([]);
    expect(validateEntity({ type: "user", display: { icon: "rocket" as never } })).toHaveLength(1);
    expect(validateEntity({ type: "user", display: { color: "#ff0000" as never } })).toHaveLength(1);
    expect(validateEntity({ type: "user", display: { fields: ["a", "b", "c", "d", "e"] } })).toHaveLength(1);
    expect(validateEntity({ type: "user", display: { fields: ["first name"] } })).toHaveLength(1);
  });
});

describe("event templates", () => {
  const dir = fileURLToPath(new URL("../../../templates/events/", import.meta.url));
  const events: EventTemplate[] = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(dir + f, "utf8")));

  it("are well formed, and each example follows its own schema", () => {
    expect(events.length).toBeGreaterThan(8);
    for (const t of events) expect([t.type, validateEventTemplate(t)]).toEqual([t.type, []]);
  });

  it("have a documentation page that matches the file", async () => {
    const { eventDocs } = await import("../../../templates/render");
    const docs = fileURLToPath(new URL("../../../docs/templates/events/", import.meta.url));
    for (const [file, content] of Object.entries(eventDocs())) {
      // Run `pnpm docs:events` after changing a template.
      expect([file, readFileSync(docs + file, "utf8") === content]).toEqual([file, true]);
    }
  });

  it("report an example that does not follow the schema", () => {
    const login = events.find((t) => t.type === "login")!;
    expect(
      validateEventTemplate({
        ...login,
        example: { deviceId: "d1", method: "carrier_pigeon", colour: "red", ip_country: 44 },
      }),
    ).toEqual([
      'example.method: "carrier_pigeon" is not one of its values',
      "example.colour: not in properties",
      "example.ip_country: should be a string",
      'example: the required entity "user" is missing',
    ]);
  });
});

describe("templates", () => {
  it("are all valid action definitions", () => {
    expect(templates.map((t) => t.name).sort()).toEqual([
      "atm_withdrawal",
      "bank_transfer",
      "ecommerce_checkout",
      "fraud_claim",
      "insurance_claim",
      "loan_application",
      "medical_claim",
      "merchant_onboarding",
      "push_payment",
      "red_flag",
      "ticket_purchase",
      "withdrawal",
    ]);
    for (const t of templates) expect([t.name, validateAction(t)]).toEqual([t.name, []]);
  });

  it("include an explanation for nothing being wrong wherever they have typologies", () => {
    for (const t of templates) {
      if (!t.typologies) continue;
      expect([t.name, Object.keys(t.typologies).some((code) => /legit|third_party|genuine/.test(code))]).toEqual([
        t.name,
        true,
      ]);
    }
  });
});

describe("decide", () => {
  const answers = (extra: GraysonResponse["answers"]): GraysonResponse => ({
    id: "dec_test",
    model: "grayson-1",
    answers: { hold: { type: "noul", value: true, probability: 0.871 }, ...extra },
    usage: { input_tokens: 10 },
  });
  const input = { subject: { type: "user" }, events: [], pendingAction: { type: "withdrawal" } };

  it("builds the response object from one model call", async () => {
    const raw = answers({
      typology: { type: "choice", value: "ato", probabilities: { ato: 0.8, scam: 0.1, mule: 0.05, legit: 0.05 } },
      reasons: { type: "multi_choice", values: ["new_device"], probabilities: { new_device: 0.99, new_location: 0.2 } },
    });
    const { decision } = await decide(input, { decider: async () => raw, action: WITHDRAWAL_ACTION });
    expect(decision).toEqual({
      decision: "review",
      probability: 0.871,
      risk_score: 87,
      reasons: ["new_device"],
      typology: "ato",
      rules: [],
      action: "withdrawal@0",
    });
  });

  it("works for an action with only a hold question", async () => {
    const { decision } = await decide(input, {
      decider: async () => answers({}),
      action: { name: "payout", version: 1, subject: "merchant", hold: "Hold?" },
    });
    expect(decision).toEqual({
      decision: "review",
      probability: 0.871,
      risk_score: 87,
      reasons: [],
      rules: [],
      action: "payout@1",
    });
  });
});
