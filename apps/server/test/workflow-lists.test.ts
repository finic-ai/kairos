import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createWorkflowRunner } from "../src/modules/workflows/libs";
import { createJobs } from "../src/platform/jobs/worker";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { JobsService } from "../src/services/job.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const repos = createRepositories(database.db);
let modelCalls = 0;
const decider = async () => {
  modelCalls++;
  throw new Error("no model call in these tests");
};
const now = () => new Date();
const app = createApp({
  repos,
  environments: environmentsRepository(database.db),
  accounts: tenancyRepository(database.db),
  decider,
  now,
});
const jobs = createJobs({
  repo: new JobsService(database.db),
  kinds: [createWorkflowRunner({ repos, decider, now, allowPrivate: true })],
  now,
  log: () => {},
});

const call = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: "Bearer key_a", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const save = (name: string, steps: unknown[], trigger: unknown = { type: "manual" }) =>
  call("PUT", `/v1/workflows/${name}`, { trigger, steps });
const run = async (name: string, input: Record<string, unknown>) =>
  (await call("POST", `/v1/workflows/${name}/runs`, { input, wait: true })).body;
const runsOf = async (name: string) => (await call("GET", `/v1/workflows/${name}/runs`)).body.runs as any[];
const labelsOf = async (type: string, id: string) =>
  ((await call("GET", `/v1/entities/${type}/${id}`)).body.labels ?? []).map((l: any) => l.label);
const send = (events: Record<string, unknown>[]) =>
  call("POST", "/v1/events", { batch: events.map((e) => ({ ts: new Date().toISOString(), ...e })) });

const BTC = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const ETH = "0x52908400098527886E0F7030069857D2E4169EE7";

const screen = {
  inputs: [
    { name: "address", type: "text", required: true },
    { name: "amount", type: "number", required: true },
    { name: "new_address", type: "boolean" },
  ],
  rules: [
    {
      id: "blocked_address",
      name: "Blocked address",
      when: "inList(input.address, 'blocked_crypto_addresses')",
      outcome: "reject",
      response: { reason: "blocked_address" },
    },
    {
      id: "new_address_large",
      name: "Large to a new address",
      when: "input.new_address == true && input.amount >= 5000",
      outcome: "reject",
      response: { reason: "new_address_large" },
    },
  ],
  default: { outcome: "approve" },
  tests: [{ name: "Small, known", input: { address: "x", amount: 10, new_address: false }, outcome: "approve" }],
};

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a" });
  modelCalls = 0;
  // Base58 addresses differ by case, so the list matches case by case. A hex address does not.
  await call("PUT", "/v1/lists/blocked_crypto_addresses", {
    name: "Blocked crypto addresses",
    case_sensitive: true,
  });
  await call("POST", "/v1/lists/blocked_crypto_addresses/items", {
    items: [{ value: ETH, case_sensitive: false, note: "Mixer" }],
  });
  await call("PUT", "/v1/rulesets/crypto_screen/draft", { name: "Crypto withdrawal screen", definition: screen });
  await call("POST", "/v1/rulesets/crypto_screen/publish");
});

const screenWithdrawals = () =>
  save(
    "screen_crypto_withdrawals",
    [
      {
        id: "screen",
        name: "Screen the address",
        type: "ruleset",
        ruleset: "crypto_screen",
        input: {
          address: "{{ event.properties.address }}",
          amount: "{{ event.properties.amount }}",
          new_address: "{{ event.properties.new_address }}",
        },
      },
      {
        id: "held",
        name: "If rejected",
        type: "condition",
        when: "steps.screen.output.outcome == 'reject'",
        then: [
          {
            id: "label",
            name: "Label the user",
            type: "record.update",
            record: "object",
            entity: "user",
            record_id: "{{ event.entities.user }}",
            add_label: "blocked_address_attempt",
          },
          {
            id: "hold",
            name: "Hold",
            type: "return",
            value: { held: true, reason: "{{ steps.screen.output.response.reason }}" },
          },
        ],
        else: [{ id: "pay", name: "Pay", type: "return", value: { held: false } }],
      },
    ],
    { type: "event", event: "crypto_withdrawal_requested" },
  );

const flagAddresses = () =>
  save(
    "flag_risky_addresses",
    [
      {
        id: "risky",
        name: "Only risky addresses",
        type: "filter",
        when: "event.properties.risk_score >= 80 || event.properties.category in ['sanctions', 'mixer', 'scam']",
      },
      {
        id: "flag",
        name: "Flag the address",
        type: "record.update",
        record: "object",
        entity: "crypto_address",
        record_id: "{{ event.entities.crypto_address }}",
        add_label: "flagged",
      },
      {
        id: "block",
        name: "Block the address",
        type: "list.add",
        list: "blocked_crypto_addresses",
        value: "{{ event.entities.crypto_address }}",
        note: "{{ event.properties.category }}, risk {{ event.properties.risk_score }}",
      },
    ],
    { type: "event", event: "address_screened" },
  );

describe("blocked crypto addresses", () => {
  it("holds a withdrawal to a blocked address, and pays one to another address", async () => {
    expect((await screenWithdrawals()).status).toBe(200);
    await send([
      {
        id: "w1",
        type: "crypto_withdrawal_requested",
        entities: { user: "u1" },
        properties: { address: ETH.toLowerCase(), amount: 50, new_address: false },
      },
      {
        id: "w2",
        type: "crypto_withdrawal_requested",
        entities: { user: "u2" },
        properties: { address: BTC, amount: 50, new_address: false },
      },
    ]);
    await jobs.drain();
    const outputs = (await runsOf("screen_crypto_withdrawals")).map((r) => r.output);
    expect(outputs).toEqual(expect.arrayContaining([{ held: true, reason: "blocked_address" }, { held: false }]));
    expect(await labelsOf("user", "u1")).toEqual(["blocked_address_attempt"]);
    expect(await labelsOf("user", "u2")).toEqual([]);
  });

  it("flags a risky address and blocks it, so the next withdrawal to it is held", async () => {
    await screenWithdrawals();
    await flagAddresses();
    await send([
      {
        id: "s1",
        type: "address_screened",
        entities: { crypto_address: BTC },
        properties: { risk_score: 92, category: "scam" },
      },
      {
        id: "s2",
        type: "address_screened",
        entities: { crypto_address: "bc1qsafe" },
        properties: { risk_score: 10, category: "exchange" },
      },
    ]);
    await jobs.drain();
    expect(await labelsOf("crypto_address", BTC)).toEqual(["flagged"]);
    expect(await labelsOf("crypto_address", "bc1qsafe")).toEqual([]);
    const list = (await call("GET", "/v1/lists/blocked_crypto_addresses")).body;
    expect(list.items.find((i: any) => i.value === BTC)).toMatchObject({
      note: "scam, risk 92",
      added_by: "workflow:flag_risky_addresses@1",
    });

    await send([
      {
        id: "w3",
        type: "crypto_withdrawal_requested",
        entities: { user: "u3" },
        properties: { address: BTC, amount: 20, new_address: false },
      },
      // Base58 is case sensitive: the same letters in another case are another address.
      {
        id: "w4",
        type: "crypto_withdrawal_requested",
        entities: { user: "u4" },
        properties: { address: BTC.toUpperCase(), amount: 20, new_address: false },
      },
    ]);
    await jobs.drain();
    expect(await labelsOf("user", "u3")).toEqual(["blocked_address_attempt"]);
    expect(await labelsOf("user", "u4")).toEqual([]);
    const held = (await runsOf("screen_crypto_withdrawals")).find((r) => r.output?.held);
    const detail = (await call("GET", `/v1/workflow-runs/${held.id}`)).body;
    expect(detail.steps[0].output.terms).toEqual([{ list: "blocked_crypto_addresses", item: BTC }]);
  });

  it("decides a withdrawal in a decision workflow, with the ruleset before the answer and no model call", async () => {
    await call("PUT", "/v1/actions/crypto_withdrawal", { subject: "user", hold: "Should this withdrawal be held?" });
    const saved = await save(
      "decide_crypto",
      [
        {
          id: "screen",
          name: "Screen",
          type: "ruleset",
          ruleset: "crypto_screen@1",
          input: { address: "{{ trigger.properties.address }}", amount: "{{ trigger.properties.amount }}" },
        },
        {
          id: "rejected",
          name: "If rejected",
          type: "condition",
          when: "steps.screen.output.outcome == 'reject'",
          then: [
            {
              id: "block",
              name: "Block",
              type: "return",
              value: { outcome: "block", reasons: ["{{ steps.screen.output.response.reason }}"] },
            },
          ],
          else: [{ id: "approve", name: "Approve", type: "return", value: { outcome: "approve" } }],
        },
      ],
      { type: "decision", action: "crypto_withdrawal" },
    );
    expect(saved.status).toBe(200);
    const decide = (address: string) =>
      call("POST", "/v1/decide", {
        action: "crypto_withdrawal",
        entities: { user: "u1" },
        properties: { address, amount: 50 },
      });
    const blocked = await decide(ETH);
    expect(blocked.body).toMatchObject({ decision: "block", reasons: ["blocked_address"] });
    expect((await decide(BTC)).body.decision).toBe("approve");
    expect(modelCalls).toBe(0);
  });

  it("screens an address that a webhook sends, with inList in a filter", async () => {
    await save(
      "hook_screen",
      [
        {
          id: "blocked",
          name: "Only blocked",
          type: "filter",
          when: "inList(trigger.body.address, 'blocked_crypto_addresses')",
        },
        { id: "done", name: "Done", type: "return", value: { blocked: "{{ trigger.body.address }}" } },
      ],
      { type: "webhook", method: "POST" },
    );
    const { path } = (await call("POST", "/v1/workflows/hook_screen/hook")).body;
    const deliver = async (address: string) => {
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      return (await response.json()).run_id as string;
    };
    const blocked = await deliver(ETH);
    const other = await deliver(BTC);
    await jobs.drain();
    const status = async (id: string) => (await call("GET", `/v1/workflow-runs/${id}`)).body;
    expect(await status(blocked)).toMatchObject({ status: "done", output: { blocked: ETH } });
    expect((await status(other)).status).toBe("filtered");
  });
});

describe("lists under load", () => {
  it("keeps every item when runs add to one list at the same time", async () => {
    await save("block", [
      { id: "add", name: "Block", type: "list.add", list: "blocked_crypto_addresses", value: "{{ trigger.address }}" },
    ]);
    const addresses = Array.from({ length: 8 }, (_, i) => `bc1qparallel${i}`);
    const done = await Promise.all(addresses.map((address) => run("block", { address })));
    expect(done.every((r) => r.status === "done" && r.output.added)).toBe(true);
    const list = (await call("GET", "/v1/lists/blocked_crypto_addresses")).body;
    expect(list.item_count).toBe(addresses.length + 1);
  });

  it("matches against 10,000 items quickly, and refuses one more", async () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({ value: `bc1qbulk${String(i).padStart(6, "0")}` }));
    expect((await call("PUT", "/v1/lists/blocked_crypto_addresses/items", { items })).status).toBe(200);
    const started = performance.now();
    const result = (
      await call("POST", "/v1/rulesets/crypto_screen/evaluate", { input: { address: "bc1qbulk009999", amount: 1 } })
    ).body;
    const ms = performance.now() - started;
    expect(result).toMatchObject({ rule: "blocked_address", terms: [{ item: "bc1qbulk009999" }] });
    expect(ms).toBeLessThan(1000);
    const over = await call("POST", "/v1/lists/blocked_crypto_addresses/items", { items: [{ value: "one_more" }] });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain("at most 10,000 items");
  });
});

describe("a list that a workflow uses", () => {
  it("cannot be deleted while a workflow reads it or changes it, and can after the workflow is archived", async () => {
    await call("PUT", "/v1/lists/watched", { name: "Watched" });
    await save("reads", [{ id: "f", name: "F", type: "filter", when: "inList(trigger.a, 'watched')" }]);
    await save("writes", [{ id: "a", name: "A", type: "list.add", list: "watched", value: "x" }]);
    const readers = (await call("GET", "/v1/lists/watched/readers")).body;
    expect(readers).toEqual({ rulesets: [], workflows: [{ name: "reads" }, { name: "writes" }] });
    const refused = await call("DELETE", "/v1/lists/watched");
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      'The list "watched" is used by the workflow "reads", the workflow "writes": change them first',
    );
    await call("POST", "/v1/workflows/reads/archive");
    await call("POST", "/v1/workflows/writes/archive");
    expect((await call("DELETE", "/v1/lists/watched")).status).toBe(200);
  });
});
