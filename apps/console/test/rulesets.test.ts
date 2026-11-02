import { describe, expect, it } from "vitest";
import { itemsFromText } from "../src/lib/lists";
import { conditionChips, problemPlace, problemText, sampleInput } from "../src/lib/rulesets";

describe("the items of a list from a pasted text", () => {
  it("takes one item for each line, once each", () => {
    expect(itemsFromText("mailinator.com\n\n yopmail.com \nmailinator.com", "lines")).toEqual([
      "mailinator.com",
      "yopmail.com",
    ]);
    expect(itemsFromText("gift card, now", "lines")).toEqual(["gift card, now"]);
  });

  it("splits at commas too, and keeps a comma inside quotes", () => {
    expect(itemsFromText('a.com, b.com,\n"gift card, now",c.com\n"say ""hi"""', "commas")).toEqual([
      "a.com",
      "b.com",
      "gift card, now",
      "c.com",
      'say "hi"',
    ]);
  });
});

describe("the ruleset builder", () => {
  it("shows each condition of a rule as one line, joined as the rule joins them", () => {
    expect(conditionChips("input.amount >= 1000 && input.country in ['KP', 'IR']")).toEqual({
      join: "And",
      chips: ["amount is at least 1000", "country is one of KP, IR"],
    });
    expect(conditionChips("inList(input.email_domain, 'disposable')").chips).toEqual([
      "email_domain is in the list disposable",
    ]);
    expect(conditionChips("size(input.cards) > 3").chips).toEqual(["size(input.cards) > 3"]);
    expect(conditionChips("").chips).toEqual([]);
  });

  it("shows a problem on the card it is about, with the part of the rule", () => {
    expect(problemPlace("rules.big.when: give a condition")).toBe("rule:big");
    expect(problemText("rules.big.when: give a condition")).toBe("If: give a condition");
    expect(problemPlace("inputs.amount.type: text, number")).toBe("start");
    expect(problemPlace('tests.0: "Risky" gave approve')).toBe("tests");
    expect(problemPlace("rules: add at least one rule")).toBe("ruleset");
  });

  it("starts a test with a usual value for each input", () => {
    expect(
      sampleInput({
        inputs: [
          { name: "amount", type: "number" },
          { name: "trusted", type: "boolean", default: true },
          { name: "country", type: "text" },
        ],
        rules: [],
        default: { outcome: "approve" },
        tests: [],
      }),
    ).toEqual({ amount: 0, trusted: true, country: "" });
  });
});
