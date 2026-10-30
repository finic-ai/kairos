/**
 * Experiment: do facts that standard event fields make possible improve decisions?
 *
 * If Kairos knew which events move money in and out, and which field is the amount, it
 * could compute money in against money out, and compare both with what is usual. This
 * script adds those facts to the context of every evaluation case and compares the result
 * with the same cases without them. Nothing in the product changes.
 *
 *   GRAYSON_API_KEY=... pnpm --filter @kairos/eval exec tsx src/experiments/money-flow.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  actionPolicy,
  applyPolicy,
  buildContext,
  buildQuestions,
  createGraysonClient,
  type Decider,
} from "@kairos/core";
import { WITHDRAWAL_ACTION } from "../withdrawal";
import { KINDS, type EvalCase } from "../generate";

const here = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const DAY = 86_400_000;
const WINDOW = 14;
// What a standard `transaction` event would tell Kairos, written by hand for this data.
const MONEY_IN = new Set(["deposit_bank"]);
const MONEY_OUT = new Set(["withdrawal_crypto"]);
const time = (ts: string) => Date.parse(ts.length === 16 ? `${ts}:00Z` : ts);

function moneyFlow(c: EvalCase) {
  const now = time(String(c.pending_action.requested_at));
  const since = now - WINDOW * DAY;
  const sum = (types: Set<string>, from: number, to: number) =>
    c.events
      .filter((e) => types.has(e.type) && time(e.ts) >= from && time(e.ts) < to)
      .reduce((a, e) => a + Number(e.usd ?? 0), 0);
  const first = time(c.events[0]!.ts);
  const windows = (since - first) / (WINDOW * DAY);
  const usual = (types: Set<string>) => (windows >= 1 ? Math.round(sum(types, first, since) / windows) : null);
  const moneyIn = Math.round(sum(MONEY_IN, since, now + 1));
  const moneyOut = Math.round(sum(MONEY_OUT, since, now + 1));
  const pending = Number(c.pending_action.usd ?? 0);
  if (process.env.FLOW_VARIANT === "short") {
    // The same facts as two ratios, in case the longer block is what hurts.
    const usualIn = usual(MONEY_IN);
    return {
      money_in_last_14_days_against_usual: usualIn
        ? `${Math.round((10 * moneyIn) / usualIn) / 10} times`
        : "no earlier history",
      share_of_that_money_leaving_with_this_action:
        moneyIn > 0 ? Math.round((100 * (moneyOut + pending)) / moneyIn) / 100 : null,
    };
  }
  return {
    [`last_${WINDOW}_days`]: { money_in_usd: moneyIn, money_out_usd: moneyOut },
    [`usual_per_${WINDOW}_days_before_that`]:
      windows >= 1 ? { money_in_usd: usual(MONEY_IN), money_out_usd: usual(MONEY_OUT) } : "no earlier history",
    pending_out_usd: pending,
    share_of_recent_money_in_that_leaves_with_this_action:
      moneyIn > 0 ? Math.round((100 * (moneyOut + pending)) / moneyIn) / 100 : null,
  };
}

const dir = here("experiments/cache");
mkdirSync(dir, { recursive: true });
let calls = 0;
let live: Decider | undefined;
const decider: Decider = async (request) => {
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
  const file = [`${here("cache")}/${hash}.json`, `${dir}/${hash}.json`].find(existsSync);
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  live ??= createGraysonClient({ apiKey: process.env.GRAYSON_API_KEY!, timeoutMs: 60_000 });
  const response = await live(request);
  calls++;
  writeFileSync(`${dir}/${hash}.json`, JSON.stringify(response));
  return response;
};

interface Result {
  probability: number;
  outcome: string;
  rule: boolean;
}

async function run(c: EvalCase, withFlow: boolean): Promise<Result> {
  const base = buildContext({
    subject: { type: "user", ...c.account },
    events: c.events,
    pendingAction: c.pending_action,
    linkedEntities: c.linked_entities,
  });
  // The same context, with the money-flow facts placed after the summary of older events.
  const { subject, baseline_of_older_events, ...rest } = base;
  const context = withFlow ? { subject, baseline_of_older_events, money_flow: moneyFlow(c), ...rest } : base;
  const raw = await decider({ model: "grayson-1", context, questions: buildQuestions(WITHDRAWAL_ACTION) });
  const hold = raw.answers.hold as { probability: number };
  const reasons = raw.answers.reasons as { probabilities: Record<string, number> };
  const present = Object.entries(reasons.probabilities)
    .filter(([, p]) => p >= 0.5)
    .map(([code]) => code);
  const outcome = applyPolicy(actionPolicy(WITHDRAWAL_ACTION), hold.probability, present);
  return { probability: hold.probability, outcome: outcome.decision, rule: outcome.rules.length > 0 };
}

const cases: EvalCase[] = readFileSync(here("cases/v1.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const rows: { c: EvalCase; base: Result; flow: Result }[] = [];
for (let i = 0; i < cases.length; i += 2) {
  rows.push(
    ...(await Promise.all(
      cases.slice(i, i + 2).map(async (c) => ({ c, base: await run(c, false), flow: await run(c, true) })),
    )),
  );
}

const mean = (v: number[]) => (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2);
const held = (r: Result) => r.outcome === "review" || r.outcome === "block";
console.log("                      mean hold probability   held by the score   stepped up by the rule");
console.log("kind                   without    with          without  with      without  with");
for (const kind of KINDS) {
  const k = rows.filter((r) => r.c.kind === kind);
  const n = (f: (r: (typeof rows)[number]) => boolean) => String(k.filter(f).length).padStart(2);
  console.log(
    `${kind.padEnd(21)}  ${mean(k.map((r) => r.base.probability)).padStart(7)}  ${mean(k.map((r) => r.flow.probability)).padStart(6)}  ` +
      `         ${n((r) => held(r.base))}     ${n((r) => held(r.flow))}           ${n((r) => r.base.outcome === "step_up")}     ${n((r) => r.flow.outcome === "step_up")}`,
  );
}
for (const [name, pick] of [
  ["without", (r: (typeof rows)[number]) => r.base],
  ["with", (r: (typeof rows)[number]) => r.flow],
] as const) {
  const pos = rows.filter((r) => r.c.label === 1).map(pick);
  const neg = rows.filter((r) => r.c.label === 0).map(pick);
  let wins = 0;
  for (const p of pos)
    for (const q of neg) wins += p.probability > q.probability ? 1 : p.probability === q.probability ? 0.5 : 0;
  console.log(
    `\n${name.padEnd(8)} catch rate ${(pos.filter((r) => r.outcome !== "approve").length / pos.length).toFixed(3)}` +
      `  held by score ${(pos.filter(held).length / pos.length).toFixed(3)}` +
      `  false-action rate ${(neg.filter((r) => r.outcome !== "approve").length / neg.length).toFixed(3)}` +
      `  false holds ${neg.filter(held).length}  AUC ${(wins / (pos.length * neg.length)).toFixed(3)}`,
  );
}
console.log(`\n${calls} new model calls`);
const sample = rows.find((r) => r.c.kind === "scam_hard")!;
console.log("\nexample, scam_hard:", JSON.stringify(moneyFlow(sample.c)));
const normal = rows.find((r) => r.c.kind === "normal_pass_through" && r.c.note === "first_self_custody")!;
console.log("example, honest first self-custody:", JSON.stringify(moneyFlow(normal.c)));
