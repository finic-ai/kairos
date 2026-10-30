import { describe, expect, it } from "vitest";
import {
  applyPolicy,
  buildContext,
  computeTotals,
  evaluateTotals,
  parseWindow,
  totalsReach,
  validateAction,
  validateTotals,
  type KairosEvent,
  type Policy,
  type TotalDefinition,
} from "../src";

const NOW = Date.parse("2026-10-06T14:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 19); // no zone, as the model sees it
const deposit = (daysAgo: number, usd: unknown, extra: Record<string, unknown> = {}): KairosEvent => ({
  ts: at(daysAgo),
  type: "wallet_transaction",
  direction: "in",
  amount: usd,
  status: "completed",
  ...extra,
});

const events: KairosEvent[] = [
  deposit(80, 300),
  deposit(50, 300),
  deposit(20, 300),
  deposit(3, 9000),
  deposit(0.5, 8000),
  deposit(0.4, 500, { status: "returned" }),
  deposit(0.3, "n/a"),
  { ts: at(0.2), type: "wallet_transaction", direction: "out", amount: 16000, status: "pending" },
  { ts: at(0.1), type: "login" },
];
const moneyIn: TotalDefinition = {
  name: "money_in",
  event: "wallet_transaction",
  sum: "amount",
  where: { direction: "in", status: "completed" },
  window: "7d",
};

describe("windows", () => {
  it("reads minutes, hours and days", () => {
    expect([parseWindow("30m"), parseWindow("24h"), parseWindow("7d")]).toEqual([1_800_000, DAY, 7 * DAY]);
    expect([parseWindow("7"), parseWindow("7w"), parseWindow("0d"), parseWindow("401d"), parseWindow(7)]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("knows how far back an action's totals read", () => {
    expect(totalsReach([moneyIn, { ...moneyIn, name: "b", usual: "90d" }])).toBe(90 * DAY);
    expect(totalsReach([moneyIn, { ...moneyIn, name: "b", window: undefined }])).toBeNull();
  });
});

describe("calculating totals", () => {
  it("adds the amounts that match, inside the window, and counts them", () => {
    // 9000 and 8000: the returned one, the one that is not a number and the money out are not counted.
    expect(computeTotals([moneyIn], events, {}, NOW)).toEqual({ money_in_last_7d: { sum: 17000, events: 2 } });
    expect(computeTotals([{ ...moneyIn, window: "24h" }], events, {}, NOW)).toEqual({
      money_in_last_24h: { sum: 8000, events: 1 },
    });
    expect(computeTotals([{ ...moneyIn, window: undefined }], events, {}, NOW)).toEqual({
      money_in_all_time: { sum: 17900, events: 5 },
    });
  });

  it("matches any value of a list, and leaves out events after the decision", () => {
    const out: TotalDefinition = {
      name: "money_out",
      event: "wallet_transaction",
      sum: "amount",
      where: { direction: "out", status: ["completed", "pending"] },
      window: "24h",
    };
    expect(computeTotals([out], events, {}, NOW)).toEqual({ money_out_last_24h: { sum: 16000, events: 1 } });
    expect(computeTotals([out], events, {}, NOW - DAY)).toEqual({ money_out_last_24h: { sum: 0, events: 0 } });
  });

  it("compares the window with a usual one, so the model does not have to", () => {
    // Before the last 7 days: 900 in 83 days, which is 75.9 for a usual week. 17000 / 75.9 = 224.
    const result = computeTotals([{ ...moneyIn, usual: "90d" }], events, {}, NOW);
    expect(result).toEqual({
      money_in_last_7d: { sum: 17000, events: 2 },
      money_in_last_7d_against_a_usual_7d: "224 times",
    });
    const fresh = [deposit(1, 500)];
    expect(computeTotals([{ ...moneyIn, usual: "90d" }], fresh, {}, NOW).money_in_last_7d_against_a_usual_7d).toBe(
      "no earlier money_in",
    );
    expect(computeTotals([{ ...moneyIn, usual: "90d" }], [], {}, NOW).money_in_last_7d_against_a_usual_7d).toBe("none");
  });

  it("says what share of the action the total covers", () => {
    const covers = { ...moneyIn, covers: "amount" };
    expect(
      computeTotals([covers], events, { amount: 16000 }, NOW).share_of_this_action_that_money_in_last_7d_covers,
    ).toBe(1);
    expect(
      computeTotals([covers], events, { amount: 68000 }, NOW).share_of_this_action_that_money_in_last_7d_covers,
    ).toBe(0.25);
    expect(computeTotals([covers], events, {}, NOW).share_of_this_action_that_money_in_last_7d_covers).toBeNull();
  });

  it("splits a sum by a property", () => {
    const mixed = [
      deposit(1, 100, { currency: "USD" }),
      deposit(2, 50, { currency: "EUR" }),
      deposit(3, 25, { currency: "USD" }),
    ];
    expect(computeTotals([{ ...moneyIn, by: "currency" }], mixed, {}, NOW)).toEqual({
      money_in_last_7d: { sum: 175, events: 3, by_currency: { USD: 125, EUR: 50 } },
    });
  });

  it("goes into the context after the summary of older events", () => {
    const context = buildContext({
      subject: { type: "user", id: "u" },
      events,
      pendingAction: { type: "spend", requested_at: at(0) },
      totals: computeTotals([moneyIn], events, {}, NOW),
    });
    expect(Object.keys(context)).toEqual([
      "subject",
      "baseline_of_older_events",
      "totals",
      "recent_events",
      "pending_action",
    ]);
    expect(
      Object.keys(
        buildContext({
          subject: { type: "user", id: "u" },
          events,
          pendingAction: { type: "spend", requested_at: at(0) },
        }),
      ),
    ).not.toContain("totals");
  });
});

describe("validating totals", () => {
  it("accepts a good definition and names what is wrong with a bad one", () => {
    expect(validateTotals(undefined)).toEqual([]);
    expect(validateTotals([moneyIn, { ...moneyIn, name: "week", usual: "90d", covers: "amount" }])).toEqual([]);
    const problems = validateTotals([
      { name: "1st", event: "", sum: "" },
      { ...moneyIn, window: "7w" },
      { ...moneyIn, name: "a", usual: "10d" },
      { ...moneyIn, name: "b", window: undefined, usual: "90d" },
      { ...moneyIn, name: "c", by: "currency", covers: "amount" },
      { ...moneyIn, name: "d", where: { direction: { not: "in" } } as never },
      { ...moneyIn, name: "d" },
    ]);
    expect(problems.join(" | ")).toMatch(
      /\[0\]\.name.*\[0\]\.event.*\[0\]\.sum.*\[1\]\.window.*\[2\]\.usual must be at least two times.*\[3\]\.usual needs a window.*\[4\]: by cannot be used.*\[5\]\.where\.direction.*"d" is used twice/,
    );
    expect(validateTotals(Array.from({ length: 9 }, (_, i) => ({ ...moneyIn, name: `t${i}` })))[0]).toContain(
      "at most 8",
    );
  });

  it("is part of validating an action", () => {
    const action = {
      name: "spend",
      subject: "user",
      hold: "Hold this?",
      context: { totals: [{ ...moneyIn, window: "soon" }] },
    };
    expect(validateAction(action).join()).toContain("context.totals[0].window");
    expect(validateAction({ ...action, context: { totals: [moneyIn] } })).toEqual([]);
  });
});

describe("totals in policy rules", () => {
  const defs: TotalDefinition[] = [
    { ...moneyIn, usual: "90d", covers: "amount" },
    { name: "money_out", event: "wallet_transaction", sum: "amount", where: { direction: "out" }, window: "24h" },
  ];
  const { values } = evaluateTotals(defs, events, { amount: 16000 }, NOW);
  const policy = (rules: Policy["rules"]): Policy => ({ block: 0.9, review: 0.5, rules });

  it("gives the totals as numbers", () => {
    expect(values).toEqual({
      money_in: { sum: 17000, events: 2, times_usual: 224, share_covered: 1 },
      money_out: { sum: 16000, events: 1 },
    });
    expect(evaluateTotals(defs, [deposit(1, 500)], {}, NOW).values.money_in).toEqual({
      sum: 500,
      events: 1,
      times_usual: Infinity,
      share_covered: null,
    });
  });

  it("fires a rule when the comparison holds, with no signal from the model", () => {
    const limit = policy([
      { id: "daily_limit", allOf: [], when: [{ total: "money_out", op: ">", value: 5000 }], outcome: "review" },
    ]);
    expect(applyPolicy(limit, 0.02, [], values)).toEqual({ decision: "review", rules: ["daily_limit"] });
    expect(
      applyPolicy(
        policy([
          { id: "daily_limit", allOf: [], when: [{ total: "money_out", op: ">", value: 16000 }], outcome: "review" },
        ]),
        0.02,
        [],
        values,
      ).decision,
    ).toBe("approve");
    expect(
      applyPolicy(
        policy([
          { id: "at_limit", allOf: [], when: [{ total: "money_out", op: ">=", value: 16000 }], outcome: "block" },
        ]),
        0.02,
        [],
        values,
      ).decision,
    ).toBe("block");
  });

  it("needs every condition and every signal of a rule", () => {
    const rule = {
      id: "spike_out",
      allOf: ["pass_through"],
      when: [
        { total: "money_in", is: "times_usual" as const, op: ">=" as const, value: 10 },
        { total: "money_in", is: "share_covered" as const, op: ">=" as const, value: 0.9 },
      ],
      outcome: "review" as const,
    };
    expect(applyPolicy(policy([rule]), 0.1, ["pass_through"], values).rules).toEqual(["spike_out"]);
    expect(applyPolicy(policy([rule]), 0.1, [], values).rules).toEqual([]);
    expect(
      applyPolicy(
        policy([{ ...rule, when: [...rule.when, { total: "money_in", is: "events", op: "<", value: 2 }] }]),
        0.1,
        ["pass_through"],
        values,
      ).rules,
    ).toEqual([]);
  });

  it("does not fire on a total that could not be calculated", () => {
    const covered = policy([
      {
        id: "uncovered",
        allOf: [],
        when: [{ total: "money_in", is: "share_covered", op: "<", value: 0.5 }],
        outcome: "review",
      },
    ]);
    // The request carries no amount, so the share is not known.
    expect(applyPolicy(covered, 0.1, [], evaluateTotals(defs, events, {}, NOW).values).rules).toEqual([]);
    expect(applyPolicy(covered, 0.1, [], {}).rules).toEqual([]);
    expect(applyPolicy(covered, 0.1, []).rules).toEqual([]);
  });

  it("validates a rule against the totals the action declares", () => {
    const action = (rules: unknown) =>
      ({
        name: "spend",
        subject: "user",
        hold: "Hold this?",
        reasons: { a: "Reason a is present", b: "Reason b is present" },
        context: { totals: defs },
        policy: { rules },
      }) as never;
    expect(
      validateAction(
        action([{ id: "ok", allOf: [], when: [{ total: "money_out", op: ">", value: 5000 }], outcome: "review" }]),
      ),
    ).toEqual([]);
    expect(
      validateAction(
        action([
          {
            id: "ok",
            allOf: ["a"],
            when: [{ total: "money_in", is: "times_usual", op: ">=", value: 10 }],
            outcome: "review",
          },
        ]),
      ),
    ).toEqual([]);
    const problems = validateAction(
      action([
        { id: "empty", allOf: [], outcome: "review" },
        { id: "unknown", allOf: [], when: [{ total: "money_sideways", op: ">", value: 1 }], outcome: "review" },
        {
          id: "no_usual",
          allOf: [],
          when: [{ total: "money_out", is: "times_usual", op: ">", value: 1 }],
          outcome: "review",
        },
        {
          id: "no_covers",
          allOf: [],
          when: [{ total: "money_out", is: "share_covered", op: ">", value: 1 }],
          outcome: "review",
        },
        { id: "bad", allOf: [], when: [{ total: "money_out", op: "==", value: "many" }], outcome: "review" },
      ]),
    ).join(" | ");
    expect(problems).toMatch(
      /empty: needs a reason code.*"money_sideways" is not in context\.totals.*times_usual needs "usual".*share_covered needs "covers".*op must be.*value must be a number/,
    );
  });
});
