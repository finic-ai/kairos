import { describe, expect, it } from "vitest";
import {
  listSlugsIn,
  matchItem,
  normalizeItem,
  rulesetSlugProblem,
  validateRuleset,
  type ListItem,
  type ListMatch,
  type ListMatcher,
} from "../src/index";

const list = (match: ListMatch, items: ListItem[], case_sensitive = false): ListMatcher => ({
  match,
  case_sensitive,
  items,
});

describe("lists", () => {
  it("matches a value as the list's match and case say, and gives the item", () => {
    expect(matchItem(list("exact", [{ value: "mailinator.com" }]), " MAILINATOR.com ")).toBe("mailinator.com");
    expect(matchItem(list("exact", [{ value: "Bob" }], true), "bob")).toBeNull();
    expect(matchItem(list("prefix", [{ value: "411111" }]), 4111111111111111)).toBe("411111");
    expect(matchItem(list("suffix", [{ value: ".ru" }]), "mail.ru")).toBe(".ru");
    expect(matchItem(list("contains", [{ value: "card" }]), "Cardholder")).toBe("card");
    expect(matchItem(list("word", [{ value: "gift card" }]), "Buy a GIFT CARD now")).toBe("gift card");
    expect(matchItem(list("word", [{ value: "card" }]), "cardholder")).toBeNull();
    expect(matchItem(list("exact", [{ value: "x" }]), true)).toBeNull();
  });

  it("lets an item use a match and a case of its own", () => {
    const terms = list("word", [
      { value: "crypto", match: "contains" },
      { value: "BTC", case_sensitive: true },
    ]);
    expect(matchItem(terms, "cryptocurrency")).toBe("crypto");
    expect(matchItem(terms, "send btc")).toBeNull();
    expect(matchItem(terms, "send BTC")).toBe("BTC");
  });

  it("keeps an item as trimmed text, or says why it cannot be one", () => {
    expect(normalizeItem(" A.com ")).toEqual({ value: "A.com" });
    expect(normalizeItem(411111)).toEqual({ value: "411111" });
    expect(normalizeItem("  ")).toEqual({ problem: "is empty" });
    expect(normalizeItem(true)).toEqual({ problem: "must be text or a number" });
  });
});

describe("rulesets", () => {
  it("finds the lists that an expression reads", () => {
    expect(listSlugsIn("inList(input.email.split('@')[1], 'disposable') || inList(input.payee, \"blocked\")")).toEqual([
      "disposable",
      "blocked",
    ]);
  });

  it("refuses a slug that would read as an id or a route", () => {
    expect(rulesetSlugProblem("payout_rules")).toBeNull();
    expect(rulesetSlugProblem("rls_payout")).toBe('cannot start with "rls_"');
    expect(rulesetSlugProblem("test")).toBe('cannot be "test"');
    expect(rulesetSlugProblem("Payout")).not.toBeNull();
  });

  it("checks the shape of a definition", () => {
    expect(
      validateRuleset({
        inputs: [{ name: "amount", type: "number" }],
        rules: [{ id: "big", name: "Big", when: "input.amount > 1", outcome: "reject" }],
        default: { outcome: "approve" },
        tests: [{ name: "Big", input: { amount: 5 }, outcome: "reject", rule: "big" }],
      }),
    ).toEqual([]);
    expect(
      validateRuleset({
        inputs: [{ name: "amount", type: "entity" }],
        rules: [
          { id: "big", name: "Big", when: "", outcome: "block" },
          { id: "big", name: "Big", when: "true", outcome: "approve" },
        ],
        tests: [{ name: "x", input: {}, outcome: "reject", rule: "small" }],
      }),
    ).toEqual([
      "inputs.amount.type: text, number, boolean, list, object",
      "rules.big.when: give a condition",
      "rules.big.outcome: approve or reject",
      "rules.big.id: another rule has this id",
      "rules.big.name: another rule has this name",
      "default: give the outcome when no rule matches",
      'tests.0.rule: there is no rule "small"',
    ]);
  });
});
