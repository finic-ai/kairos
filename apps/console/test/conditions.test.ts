import { describe, expect, it } from "vitest";
import { fromCel, incomplete, toCel, type Group, type Op } from "../src/lib/conditions";

const rule = (field: string, op: Op, value = "") => ({
  kind: "rule" as const,
  field,
  op,
  value,
});

describe("the condition builder", () => {
  it("writes CEL from rules and groups", () => {
    const group: Group = {
      kind: "group",
      join: "all",
      items: [
        rule("event.properties.amount", "gte", "1000"),
        rule("event.properties.country", "in", "GB, FR"),
        {
          kind: "group",
          join: "any",
          items: [rule("event.status", "eq", "pending"), rule("event.properties.note", "missing")],
        },
      ],
    };
    expect(toCel(group)).toBe(
      "event.properties.amount >= 1000 && event.properties.country in ['GB', 'FR'] && (event.status == 'pending' || !has(event.properties.note))",
    );
  });

  it("keeps a quoted number a text, quotes a text, and escapes quotes in it", () => {
    expect(toCel({ kind: "group", join: "all", items: [rule("a.zip", "eq", '"02134"')] })).toBe("a.zip == '02134'");
    expect(toCel({ kind: "group", join: "all", items: [rule("a.name", "contains", "O'Brien")] })).toBe(
      "a.name.contains('O\\'Brien')",
    );
    expect(toCel({ kind: "group", join: "all", items: [rule("a.ok", "eq", "true")] })).toBe("a.ok == true");
  });

  it("leaves out rules that are not complete, and counts them", () => {
    const group: Group = { kind: "group", join: "all", items: [rule("", "eq", "1"), rule("a.b", "eq", "")] };
    expect(toCel(group)).toBe("");
    expect(incomplete(group)).toBe(2);
  });

  it("reads back what it writes", () => {
    for (const cel of [
      "event.properties.amount >= 1000 && event.properties.country in ['GB', 'FR'] && (event.status == 'pending' || !has(event.properties.note))",
      "trigger.entity.properties.tier == 'gold'",
      "steps.check.output.decision != 'approve' || has(trigger.vip)",
      "a.zip == '02134'",
      "a.name.startsWith('x') && a.name.endsWith('y') && a.name.contains('z')",
      "a.n < -5 && a.n <= 3.5 && a.n > 0",
    ])
      expect(toCel(fromCel(cel)!)).toBe(cel);
    expect(fromCel("a.zip == '02134'")!.items[0]).toMatchObject({ value: '"02134"' });
    expect(fromCel("")).toEqual({ kind: "group", join: "all", items: [] });
  });

  it("writes and reads a list check as inList", () => {
    const group: Group = { kind: "group", join: "any", items: [rule("input.email_domain", "inlist", "disposable")] };
    expect(toCel(group)).toBe("inList(input.email_domain, 'disposable')");
    expect(fromCel("inList(input.email_domain, 'disposable') || input.amount > 10")).toEqual({
      kind: "group",
      join: "any",
      items: [rule("input.email_domain", "inlist", "disposable"), rule("input.amount", "gt", "10")],
    });
  });

  it("does not read what it cannot show", () => {
    for (const cel of [
      "a.b + 1 > 2",
      "a.b == c.d",
      "a && b || c",
      "size(a.list) > 0",
      "a.list.exists(x, x > 1)",
      "a.b == 'open",
    ])
      expect(fromCel(cel)).toBeNull();
  });
});
