import { describe, expect, it } from "vitest";
import { columnTitle, timesUsual, validateEntity, validateFacts, validateLists } from "../src/index";

describe("facts", () => {
  it("accepts the facts of a user type", () => {
    expect(
      validateFacts([
        {
          name: "transactions_30d",
          label: "Transactions",
          source: "events",
          measure: "count",
          filters: { event_type: ["payment", "transfer"] },
          window: "30d",
        },
        {
          name: "money_in_7d",
          label: "Money in",
          source: "events",
          measure: "sum",
          field: "amount",
          filters: { event_type: "deposit" },
          window: "7d",
          usual: "90d",
          format: "money",
          currency: "GBP",
        },
        { name: "devices", label: "Devices", source: "events", measure: "unique", field: "device" },
        {
          name: "chargebacks",
          label: "Chargebacks",
          source: "labels",
          measure: "count",
          filters: { label: "chargeback" },
        },
        {
          name: "open_cases",
          label: "Open cases",
          source: "cases",
          measure: "count",
          filters: { status: ["open", "in_review"] },
        },
        { name: "first_seen", label: "First seen", source: "events", measure: "first" },
        {
          name: "avg_risk",
          label: "Average risk",
          source: "decisions",
          measure: "avg",
          field: "risk_score",
          filters: { outcome: ["review", "block"] },
        },
      ]),
    ).toEqual([]);
  });

  it("says what is wrong with a fact", () => {
    expect(
      validateFacts([
        { name: "a", label: "A", source: "labels", measure: "sum", field: "amount" },
        { name: "a", label: "", source: "events", measure: "sum" },
        { name: "b", label: "B", source: "decisions", measure: "avg", field: "amount" },
        { name: "c", label: "C", source: "events", measure: "count", filters: { label: "x" }, window: "2y" },
        { name: "d", label: "D", source: "events", measure: "count", window: "7d", usual: "10d" },
        { name: "e", label: "E", source: "events", measure: "avg", field: "amount", window: "7d", usual: "90d" },
        { name: "f", label: "F", source: "events", measure: "count", format: "number", currency: "GBP" },
      ]),
    ).toEqual([
      "facts[0].measure must be one of count, first, last for labels",
      'facts[1].name: "a" is used twice',
      "facts[1].label must be text of at most 80 characters",
      "facts[1].field must be a numeric property",
      "facts[2].field must be risk_score for decisions",
      "facts[3].filters.label is not a filter of events: use event_type, property",
      'facts[3].window must be like "24h", "7d" or "30d", at most 400 days, or "all"',
      "facts[4].usual must be at least two times the window",
      "facts[5].usual is only for count and sum",
      'facts[6].currency must be a code such as "GBP", with the money format',
    ]);
  });

  it("compares with the usual as an action total does", () => {
    // 90 days before a 7-day window: 83 days, so 11.86 windows. 1,186 before is 100 a window.
    expect(timesUsual(3420, 1186, 7, 90)).toBe(34.2);
    expect(timesUsual(5, 0, 7, 90)).toBe(Infinity);
    expect(timesUsual(0, 0, 7, 90)).toBeNull();
  });
});

describe("lists", () => {
  it("accepts the lists of a user type", () => {
    expect(
      validateLists([
        {
          name: "transactions",
          label: "Transactions",
          source: "events",
          filters: { event_type: ["payment", "transfer"] },
          columns: [
            "ts",
            { field: "event.amount", label: "Amount", format: "money", currency: "event.currency" },
            "event.payee",
            "decision.outcome",
          ],
        },
        {
          name: "devices",
          label: "Devices",
          source: "linked",
          entity_type: "device",
          columns: ["id", "entity.os", "first_seen", "last_seen"],
        },
        {
          name: "cases",
          label: "Cases",
          source: "cases",
          columns: ["ts", "queue", "status", "resolution"],
          sort: "oldest",
        },
      ]),
    ).toEqual([]);
  });

  it("says what is wrong with a list", () => {
    expect(
      validateLists([
        { name: "a", label: "A", source: "linked", columns: ["event.amount"] },
        { name: "b", label: "B", source: "events", entity_type: "device", columns: [] },
        {
          name: "c",
          label: "C",
          source: "cases",
          columns: [{ field: "status", format: "money", currency: "x" }],
          sort: "biggest",
        },
      ]),
    ).toEqual([
      "lists[0].entity_type must be an entity type",
      'lists[0].columns[0]: "event.amount" is not a column of linked: use id, name, first_seen, last_seen, events, entity.<property>',
      "lists[1].entity_type is only for linked",
      "lists[1].columns must be a list of 1 to 12 columns",
      'lists[2].columns[0].currency must be a code such as "GBP" or a field of the row, with the money format',
      "lists[2].sort must be newest or oldest",
    ]);
  });

  it("names a column for people", () => {
    expect(columnTitle("event.ip_country")).toBe("ip country");
    expect(columnTitle("decision.outcome")).toBe("Decision");
    expect(columnTitle({ field: "event.amount", label: "Amount" })).toBe("Amount");
  });

  it("is checked with the entity type", () => {
    expect(validateEntity({ type: "user", facts: [{ name: "x" }] as never, lists: "no" as never })).toEqual([
      "facts[0].label must be text of at most 80 characters",
      "facts[0].source must be one of events, decisions, labels, cases",
      "lists must be a list",
    ]);
  });
});
