import { fileURLToPath } from "node:url";
import { catalogInput, INPUT_CATALOG } from "@kairos/core";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadRulesetTemplates } from "../src/modules/rulesets";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const T1 = new Date("2026-10-06T14:00:00Z");
const T2 = new Date("2026-10-06T15:00:00Z");
let clock = T1;
const database = await testDatabase();
const templates = loadRulesetTemplates(fileURLToPath(new URL("../../../templates", import.meta.url)));
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
  clock = T1;
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => {
      throw new Error("no model call in these tests");
    },
    rulesetTemplates: templates,
    now: () => clock,
  });
});

const call = async (method: string, path: string, body?: unknown, key = "key_a") => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

const payout = {
  inputs: [
    { name: "amount", type: "number", required: true },
    { name: "country", type: "text" },
    { name: "email_domain", type: "text" },
  ],
  rules: [
    {
      id: "blocked_domain",
      name: "Blocked domain",
      when: "inList(input.email_domain, 'blocked_domains')",
      outcome: "reject",
      response: { status: 403 },
    },
    {
      id: "risky",
      name: "Risky country",
      when: "input.country in ['KP', 'IR'] && input.amount >= 1000",
      outcome: "reject",
    },
    { id: "small", name: "Small amount", when: "input.amount < 10", outcome: "approve", response: { fast: true } },
  ],
  default: { outcome: "approve" },
  tests: [{ name: "Risky", input: { amount: 5000, country: "KP" }, outcome: "reject", rule: "risky" }],
};

async function published(definition: Record<string, unknown> = payout, slug = "payout_rules") {
  await call("PUT", "/v1/lists/blocked_domains", { name: "Blocked domains" });
  await call("POST", "/v1/lists/blocked_domains/items", { items: [{ value: "Mailinator.com" }] });
  await call("PUT", `/v1/rulesets/${slug}/draft`, { name: "Payout rules", definition });
  return call("POST", `/v1/rulesets/${slug}/publish`);
}

describe("a ruleset's draft and versions", () => {
  it("starts as a draft at version 0, by its slug or its id", async () => {
    const made = await call("PUT", "/v1/rulesets/payout_rules/draft", {
      name: "Payout rules",
      description: "Rules for payouts",
      definition: payout,
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      slug: "payout_rules",
      name: "Payout rules",
      description: "Rules for payouts",
      settings: {},
      version: 0,
      status: "draft",
      created_by: "key_key_a",
      updated_by: "key_key_a",
    });
    expect(made.body.id).toMatch(/^rls_[0-9a-hjkmnp-tv-z]{26}$/);
    expect((await call("GET", `/v1/rulesets/${made.body.id}`)).body.slug).toBe("payout_rules");
    expect((await call("GET", "/v1/rulesets")).body.rulesets.map((r: any) => r.slug)).toEqual(["payout_rules"]);
    expect((await call("GET", "/v1/rulesets/payout_rules", undefined, "key_b")).status).toBe(404);
  });

  it("refuses a slug that reads as an id or a route, and a new ruleset with no name", async () => {
    const draft = { name: "X", definition: payout };
    expect((await call("PUT", "/v1/rulesets/rls_x/draft", draft)).body.error.message).toContain(
      'cannot start with "rls_"',
    );
    expect((await call("PUT", "/v1/rulesets/test/draft", draft)).status).toBe(400);
    expect((await call("PUT", "/v1/rulesets/Payout/draft", draft)).status).toBe(400);
    expect((await call("PUT", "/v1/rulesets/payout/draft", { definition: payout })).body.error.message).toContain(
      "name: needed",
    );
    expect((await call("PUT", "/v1/rulesets/rls_01jb8xk3m4n5p6q7r8s9t0v1w2/draft", draft)).status).toBe(404);
  });

  it("publishes only when every rule parses, every list exists and every test passes", async () => {
    const broken = {
      ...payout,
      rules: [...payout.rules, { id: "bad", name: "Bad", when: "input.amount >=", outcome: "reject" }],
    };
    await call("PUT", "/v1/rulesets/payout_rules/draft", { name: "Payout rules", definition: broken });
    const refused = await call("POST", "/v1/rulesets/payout_rules/publish");
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain("rules.bad.when:");
    expect(refused.body.error.message).toContain('there is no list "blocked_domains"');

    await call("PUT", "/v1/lists/blocked_domains", { name: "Blocked domains" });
    const failing = {
      ...payout,
      tests: [{ name: "Wrong", input: { amount: 5000, country: "KP" }, outcome: "approve" }],
    };
    await call("PUT", "/v1/rulesets/payout_rules/draft", { definition: failing });
    expect((await call("POST", "/v1/rulesets/payout_rules/publish")).body.error.message).toBe(
      'tests.0: "Wrong" gave reject from the rule "risky", not approve',
    );

    await call("PUT", "/v1/rulesets/payout_rules/draft", { definition: payout });
    clock = T2;
    const done = await call("POST", "/v1/rulesets/payout_rules/publish");
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ version: 1, status: "published", published_at: T2.toISOString() });
    expect(done.body.draft).toBeUndefined();
    expect((await call("GET", "/v1/rulesets/payout_rules/versions")).body.versions).toEqual([
      { version: 1, created: T2.toISOString(), created_by: "key_key_a" },
    ]);
    expect((await call("POST", "/v1/rulesets/payout_rules/publish")).body.error.message).toBe(
      "there are no changes to publish",
    );
  });

  it("keeps a draft beside the live version, and drops it when it equals the live version", async () => {
    await published();
    const changed = { ...payout, default: { outcome: "reject" } };
    const draft = await call("PUT", "/v1/rulesets/payout_rules/draft", { definition: changed });
    expect(draft.body).toMatchObject({ version: 1, status: "published", draft: changed });
    expect(draft.body.definition.default).toEqual({ outcome: "approve" });
    expect((await call("PUT", "/v1/rulesets/payout_rules/draft", { definition: payout })).body.draft).toBeUndefined();

    await call("PUT", "/v1/rulesets/payout_rules/draft", { definition: changed });
    expect((await call("DELETE", "/v1/rulesets/payout_rules/draft")).body.draft).toBeUndefined();
    await call("PUT", "/v1/rulesets/payout_rules/draft", { definition: changed });
    expect((await call("POST", "/v1/rulesets/payout_rules/publish")).body.version).toBe(2);
    expect((await call("GET", "/v1/rulesets/payout_rules?version=1")).body.definition.default).toEqual({
      outcome: "approve",
    });
  });

  it("changes the name, the description and the settings with no new version", async () => {
    await published();
    clock = T2;
    const changed = await call("PATCH", "/v1/rulesets/payout_rules", {
      name: "Payouts",
      description: null,
      settings: { color: "red" },
    });
    expect(changed.body).toMatchObject({ name: "Payouts", settings: { color: "red" }, version: 1 });
    expect(changed.body.description).toBeUndefined();
    expect(changed.body.updated).toBe(T2.toISOString());
    expect((await call("GET", "/v1/rulesets/payout_rules/versions")).body.versions).toHaveLength(1);
  });

  it("archives and restores, and an archived ruleset still evaluates", async () => {
    await published();
    expect((await call("POST", "/v1/rulesets/payout_rules/archive")).body.status).toBe("archived");
    expect((await call("GET", "/v1/rulesets")).body.rulesets).toEqual([]);
    expect((await call("GET", "/v1/rulesets?archived=true")).body.rulesets).toHaveLength(1);
    expect((await call("PUT", "/v1/rulesets/payout_rules/draft", { definition: payout })).status).toBe(400);
    expect((await call("POST", "/v1/rulesets/payout_rules/evaluate", { input: { amount: 5 } })).body.outcome).toBe(
      "approve",
    );
    expect((await call("POST", "/v1/rulesets/payout_rules/restore")).body.status).toBe("published");
  });
});

describe("evaluating a ruleset", () => {
  const evaluate = (input: Record<string, unknown>, query = "") =>
    call("POST", `/v1/rulesets/payout_rules/evaluate${query}`, { input });

  it("gives the outcome and the response of the first rule that matches", async () => {
    await published();
    expect((await evaluate({ amount: 5000, country: "KP" })).body).toEqual({
      ruleset: "payout_rules@1",
      outcome: "reject",
      matched: true,
      rule: "risky",
      response: null,
      terms: [],
      missing: ["blocked_domain"],
    });
    expect((await evaluate({ amount: 5, country: "KP" })).body).toMatchObject({
      outcome: "approve",
      rule: "small",
      response: { fast: true },
    });
  });

  it("gives the default when no rule matches, and leaves out the rules that read a missing input", async () => {
    await published();
    expect((await evaluate({ amount: 5000, country: null })).body).toEqual({
      ruleset: "payout_rules@1",
      outcome: "approve",
      matched: false,
      rule: null,
      response: null,
      terms: [],
      missing: ["blocked_domain", "risky"],
    });
  });

  it("matches list items as the list's match says, and gives the term", async () => {
    await published();
    expect((await evaluate({ amount: 5000, email_domain: "  MAILINATOR.com" })).body).toMatchObject({
      outcome: "reject",
      rule: "blocked_domain",
      response: { status: 403 },
      terms: [{ list: "blocked_domains", item: "Mailinator.com" }],
    });
    await call("POST", "/v1/lists/blocked_domains/items", { items: [{ value: "yopmail.com" }] });
    expect((await evaluate({ amount: 50, email_domain: "yopmail.com" })).body.rule).toBe("blocked_domain");
  });

  it("refuses an input that is required and missing, or of the wrong type", async () => {
    await published();
    expect((await evaluate({ country: "GB" })).body.error.message).toBe("input.amount: is required");
    expect((await evaluate({ amount: "a lot" })).body.error.message).toBe("input.amount: must be a number");
  });

  it("evaluates an older version", async () => {
    await published();
    await call("PUT", "/v1/rulesets/payout_rules/draft", {
      definition: { ...payout, rules: payout.rules.slice(1, 2) },
    });
    await call("POST", "/v1/rulesets/payout_rules/publish");
    expect((await evaluate({ amount: 5 })).body).toMatchObject({ ruleset: "payout_rules@2", rule: null });
    expect((await evaluate({ amount: 5 }, "?version=1")).body).toMatchObject({
      ruleset: "payout_rules@1",
      rule: "small",
    });
  });

  it("refuses a ruleset that was never published", async () => {
    await call("PUT", "/v1/rulesets/payout_rules/draft", { name: "Payout rules", definition: payout });
    expect((await evaluate({ amount: 5 })).body.error.message).toContain("never published");
  });
});

describe("testing a definition that is not saved", () => {
  it("evaluates the input and runs each test", async () => {
    await call("PUT", "/v1/lists/blocked_domains", { name: "Blocked domains" });
    const run = await call("POST", "/v1/rulesets/test", {
      definition: { ...payout, tests: [...payout.tests, { name: "Wrong", input: { amount: 1 }, outcome: "reject" }] },
      input: { amount: 3 },
    });
    expect(run.body.problems).toEqual([]);
    expect(run.body.result).toMatchObject({ ruleset: "draft", outcome: "approve", rule: "small" });
    expect(run.body.tests.map((t: any) => [t.name, t.passed])).toEqual([
      ["Risky", true],
      ["Wrong", false],
    ]);
  });

  it("gives the problems of a definition that cannot run", async () => {
    const run = await call("POST", "/v1/rulesets/test", { definition: { rules: [] } });
    expect(run.body.problems).toEqual(["default: give the outcome when no rule matches"]);
  });
});

describe("the templates", () => {
  it("use only inputs of the catalog, by its names and types", () => {
    const off = templates.flatMap((t) =>
      t.definition.inputs
        .filter((i) => catalogInput(i.name)?.type !== i.type)
        .map((i) => `${t.slug}: ${i.name} (${i.type})`),
    );
    expect(off).toEqual([]);
    expect(new Set(INPUT_CATALOG.map((i) => i.name)).size).toBe(INPUT_CATALOG.length);
  });

  it("lists every template, and each one publishes as it is", async () => {
    const listed = (await call("GET", "/v1/ruleset-templates")).body.templates;
    expect(listed).toHaveLength(18);
    expect(new Set(listed.map((t: any) => t.category))).toEqual(
      new Set(["Payments", "Accounts", "Identity", "Commerce", "Lending"]),
    );
    for (const t of listed) {
      await call("PUT", `/v1/rulesets/${t.slug}/draft`, { name: t.name, definition: t.definition });
      const done = await call("POST", `/v1/rulesets/${t.slug}/publish`);
      expect(done.status, `${t.slug}: ${JSON.stringify(done.body)}`).toBe(200);
    }
  });
});

describe("pages of rulesets and lists", () => {
  it("gives one page, the total, and searches the name and the slug", async () => {
    for (const slug of ["alpha", "bravo", "charlie"]) {
      await call("PUT", `/v1/rulesets/${slug}/draft`, { name: slug.toUpperCase(), definition: payout });
      await call("PUT", `/v1/lists/${slug}`, { name: slug.toUpperCase() });
    }
    const rulesets = await call("GET", "/v1/rulesets?limit=2&offset=1");
    expect(rulesets.body.total).toBe(3);
    expect(rulesets.body.rulesets.map((r: any) => r.slug)).toEqual(["bravo", "charlie"]);
    const lists = await call("GET", "/v1/lists?limit=2");
    expect(lists.body.total).toBe(3);
    expect(lists.body.lists.map((l: any) => l.slug)).toEqual(["alpha", "bravo"]);
    expect((await call("GET", "/v1/lists?q=char")).body).toMatchObject({ total: 1, lists: [{ slug: "charlie" }] });
  });
});

describe("lists", () => {
  it("makes a list by its slug, and reads it by its slug or its id", async () => {
    const made = await call("PUT", "/v1/lists/blocked_domains", { name: "Blocked domains" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      slug: "blocked_domains",
      match: "exact",
      case_sensitive: false,
      item_count: 0,
      items: [],
      created_by: "key_key_a",
    });
    expect(made.body.id).toMatch(/^lst_[0-9a-hjkmnp-tv-z]{26}$/);
    expect((await call("GET", `/v1/lists/${made.body.id}`)).body.slug).toBe("blocked_domains");
    expect((await call("PUT", "/v1/lists/lst_x", { name: "X" })).status).toBe(400);
    expect((await call("PUT", "/v1/lists/other")).status).toBe(400);
  });

  it("adds each item once, keeps it as written, and removes it", async () => {
    await call("PUT", "/v1/lists/blocked_domains", { name: "Blocked domains" });
    const added = await call("POST", "/v1/lists/blocked_domains/items", {
      items: [{ value: " Mailinator.com ", note: "Disposable" }, { value: "yopmail.com" }, { value: 411111 }],
    });
    expect(added.body).toMatchObject({ added: 3, updated: 0 });
    expect(added.body.list.items).toEqual([
      { value: "Mailinator.com", note: "Disposable", added_by: "key_key_a", added: T1.toISOString() },
      { value: "yopmail.com", added_by: "key_key_a", added: T1.toISOString() },
      { value: "411111", added_by: "key_key_a", added: T1.toISOString() },
    ]);
    clock = T2;
    const again = await call("POST", "/v1/lists/blocked_domains/items", {
      items: [{ value: "MAILINATOR.COM", match: "suffix", note: "Any subdomain" }],
    });
    expect(again.body).toMatchObject({ added: 0, updated: 1 });
    expect(again.body.list.items[0]).toEqual({
      value: "MAILINATOR.COM",
      match: "suffix",
      note: "Any subdomain",
      added_by: "key_key_a",
      added: T1.toISOString(),
    });
    const removed = await call("DELETE", "/v1/lists/blocked_domains/items", { values: ["YOPMAIL.com", 411111] });
    expect(removed.body).toMatchObject({ removed: 2, list: { item_count: 1 } });
    const replaced = await call("PUT", "/v1/lists/blocked_domains/items", {
      items: [{ value: "a.com" }, { value: "b.com" }],
    });
    expect(replaced.body.list.items.map((i: any) => i.value)).toEqual(["a.com", "b.com"]);
    expect(
      (await call("POST", "/v1/lists/blocked_domains/items", { items: [{ value: " " }] })).body.error.message,
    ).toBe("items.0.value: is empty");
  });

  it("matches each item with its own match and case, or with the list's", async () => {
    await call("PUT", "/v1/lists/terms", { name: "Terms", match: "word" });
    await call("POST", "/v1/lists/terms/items", {
      items: [{ value: "gift card" }, { value: "crypto", match: "contains" }, { value: "BTC", case_sensitive: true }],
    });
    const definition = {
      inputs: [{ name: "reference", type: "text" }],
      rules: [{ id: "term", name: "Term", when: "inList(input.reference, 'terms')", outcome: "reject" }],
      default: { outcome: "approve" },
    };
    const run = async (reference: string) =>
      (await call("POST", "/v1/rulesets/test", { definition, input: { reference } })).body.result;
    expect(await run("A GIFT CARD for you")).toMatchObject({
      rule: "term",
      terms: [{ list: "terms", item: "gift card" }],
    });
    expect(await run("giftcards")).toMatchObject({ rule: null });
    expect(await run("cryptocurrency")).toMatchObject({ terms: [{ list: "terms", item: "crypto" }] });
    expect(await run("send btc")).toMatchObject({ rule: null });
    expect(await run("send BTC")).toMatchObject({ rule: "term" });
  });

  it("refuses a change of case that would make two items the same", async () => {
    await call("PUT", "/v1/lists/names", { name: "Names", case_sensitive: true });
    await call("POST", "/v1/lists/names/items", { items: [{ value: "Bob" }, { value: "bob" }] });
    expect((await call("GET", "/v1/lists/names")).body.item_count).toBe(2);
    expect((await call("PUT", "/v1/lists/names", { case_sensitive: false })).status).toBe(400);
    expect((await call("PUT", "/v1/lists/names", { match: "prefix" })).body).toMatchObject({
      match: "prefix",
      case_sensitive: true,
    });
  });

  it("is not deleted while a ruleset reads it", async () => {
    await published();
    const refused = await call("DELETE", "/v1/lists/blocked_domains");
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('"Payout rules"');
    expect((await call("GET", "/v1/lists/blocked_domains/readers")).body).toEqual({
      rulesets: [{ slug: "payout_rules", name: "Payout rules" }],
      workflows: [],
    });
    await call("POST", "/v1/rulesets/payout_rules/archive");
    expect((await call("DELETE", "/v1/lists/blocked_domains")).status).toBe(200);
    const left = await database.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM lists`);
    expect(left.rows[0]!.n).toBe(0);
  });
});
