/**
 * Experiment: do totals over event fields improve decisions when the signal is only in
 * events older than the recent 30? This is the case that totals were built for: see "Totals" in docs/reference/clients/typescript.md.
 *
 * The script builds 40 cases where money in and money out are the only difference between
 * a mule and an honest customer, and where the deposits are buried under routine events,
 * so the model sees them only as a count, a median and a maximum. It then decides each
 * case three ways: with today's context, with raw sums (the form in the proposal), and
 * with the same facts as two ratios. It also runs the 100 accepted cases the same three
 * ways, to see what totals cost where they are not needed. Nothing in the product changes.
 *
 *   GRAYSON_API_KEY=... pnpm --filter @kairos/eval exec tsx src/experiments/totals.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  actionPolicy,
  applyPolicy,
  buildContext,
  buildQuestions,
  computeTotals,
  createGraysonClient,
  type Decider,
  type KairosEvent,
  type TotalDefinition,
} from "@kairos/core";
import type { EvalCase } from "../generate";
import { Rng } from "../rng";
import { WITHDRAWAL_ACTION } from "../withdrawal";

const here = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 6, 14, 0);
const ts = (t: number) => new Date(t).toISOString().slice(0, 16);
const time = (stamp: string) => Date.parse(stamp.length === 16 ? `${stamp}:00Z` : stamp);

const NEW_KINDS = ["mule_fast", "mule_slow", "honest_old_money", "honest_saver"] as const;
type NewKind = (typeof NEW_KINDS)[number];

interface Case {
  id: string;
  kind: string;
  label: 0 | 1;
  account: Record<string, unknown>;
  events: KairosEvent[];
  pending_action: Record<string, unknown>;
  linked_entities?: EvalCase["linked_entities"];
}

/** Routine sessions between two moments: a login, then views, small trades, and now and then a usual deposit. */
function routine(
  r: Rng,
  device: string,
  loc: readonly [string, string],
  usual: number,
  from: number,
  to: number,
  count: number,
  deposits = true,
): KairosEvent[] {
  const events: KairosEvent[] = [];
  while (events.length < count) {
    let t = from + r.float(0, 1) * (to - from);
    events.push({ ts: ts(t), type: "login", device, ip_country: loc[0], ip_city: loc[1] });
    for (let i = r.int(1, 4); i > 0 && events.length < count; i--) {
      t += r.int(1, 5) * MIN;
      if (t >= to) break;
      const type = r.weighted(
        ["view_portfolio", "view_prices", "buy", "sell", "deposit_bank", "price_alert_set"],
        [34, 34, 12, 5, deposits ? 9 : 0, 6],
      );
      const e: KairosEvent = { ts: ts(t), type };
      if (type === "buy" || type === "sell")
        Object.assign(e, { asset: r.pick(["BTC", "ETH", "SOL"]), usd: Math.round(usual * r.float(0.3, 1.2)) });
      if (type === "deposit_bank") e.usd = Math.round(usual * r.float(0.8, 1.3));
      events.push(e);
    }
  }
  return events;
}

function makeCase(kind: NewKind, index: number): Case {
  const r = new Rng(9000 + NEW_KINDS.indexOf(kind) * 100 + index);
  const loc = r.pick([
    ["GB", "London"],
    ["GB", "Leeds"],
    ["PT", "Lisbon"],
    ["IE", "Dublin"],
  ] as const);
  const device = r.id("dev");
  const addr = r.id("addr");
  const usual = r.pick([100, 200, 300, 500]);
  const big = () => Math.round(r.float(6000, 14000) / 50) * 50;
  const deposit = (t: number, usd: number): KairosEvent => ({ ts: ts(t), type: "deposit_bank", usd });

  // Every case: about four months of routine, and one large deposit long ago, so that the
  // largest deposit in the baseline is large for the honest customers too.
  const events = routine(r, device, loc, usual, NOW - 120 * DAY, NOW - 9 * DAY, 170);
  let funded = 0; // the money the withdrawal draws on

  if (kind === "mule_fast") {
    // Several large deposits in the last day, then the money leaves.
    let t = NOW - r.float(14, 22) * HOUR;
    for (let i = r.int(3, 5); i > 0; i--) {
      const usd = big();
      events.push(deposit(t, usd));
      funded += usd;
      t += r.float(20, 70) * MIN;
    }
    events.push(deposit(NOW - r.float(70, 110) * DAY, big()));
  } else if (kind === "mule_slow") {
    // Large deposits on several of the last seven days.
    for (let i = r.int(4, 6); i > 0; i--) {
      const usd = big();
      events.push(deposit(NOW - r.float(1.4, 6.8) * DAY, usd));
      funded += usd;
    }
    events.push(deposit(NOW - r.float(70, 110) * DAY, big()));
  } else if (kind === "honest_old_money") {
    // The same amount of money, but it arrived two to four months ago.
    for (let i = r.int(3, 5); i > 0; i--) {
      const usd = big();
      events.push(deposit(NOW - r.float(60, 115) * DAY, usd));
      funded += usd;
    }
  } else {
    // A saver: one large deposit near the start of each month, the last one more than a week ago.
    for (const daysAgo of [100, 69, 39, 9]) {
      const usd = big();
      events.push(deposit(NOW - (daysAgo + r.float(0, 2)) * DAY, usd));
      funded += usd;
    }
  }

  // Every case has a deposit of the usual size in the last day, so "last deposit" does not tell them apart,
  // and enough routine events after the money arrived to push every deposit out of the recent 30.
  events.push(deposit(NOW - r.float(7, 11) * HOUR, Math.round(usual * r.float(0.8, 1.3))));
  events.push(...routine(r, device, loc, usual, NOW - 6.5 * HOUR, NOW - 15 * MIN, r.int(38, 44), false));
  events.push(
    { ts: ts(NOW - 9 * MIN), type: "login", device, ip_country: loc[0], ip_city: loc[1] },
    { ts: ts(NOW - 6 * MIN), type: "view_portfolio" },
  );

  const usd = Math.round(funded * r.float(0.9, 0.97));
  return {
    id: `${kind}-${String(index).padStart(2, "0")}`,
    kind,
    label: kind.startsWith("mule") ? 1 : 0,
    // Only what an integration would send. No balance, which would give the answer away.
    account: { opened: ts(NOW - r.int(400, 900) * DAY).slice(0, 10), kyc_country: loc[0], home_city: loc[1] },
    events: events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)),
    pending_action: {
      type: "withdrawal_crypto",
      asset: "BTC",
      usd,
      pct_of_balance: r.int(86, 96),
      destination: addr,
      destination_added: "more than 1 year ago",
      requested_at: ts(NOW),
    },
  };
}

type Variant = "none" | "sums" | "ratios" | "built";

/**
 * The feature as it was built after the first run: declared totals, calculated by the
 * product's own code. One total gives the sum, the comparison with a usual week, and the
 * share of the withdrawal it covers.
 */
const DECLARED: TotalDefinition[] = [
  { name: "money_in", event: "deposit_bank", sum: "usd", window: "7d", usual: "90d", covers: "usd" },
];

function totals(c: Case, variant: Exclude<Variant, "none">) {
  const now = time(String(c.pending_action.requested_at));
  if (variant === "built") return computeTotals(DECLARED, c.events, c.pending_action, now);
  const total = (type: string, window: number) => {
    const matched = c.events.filter(
      (e) => e.type === type && time(e.ts) >= now - window && time(e.ts) <= now && Number.isFinite(Number(e.usd)),
    );
    return { sum: Math.round(matched.reduce((a, e) => a + Number(e.usd), 0)), events: matched.length };
  };
  const inside = (window: number) => total("deposit_bank", window);
  const outside = (window: number) => total("withdrawal_crypto", window);
  if (variant === "sums") {
    // The form in the proposal: a named sum and the number of events behind it.
    return {
      money_in_24h: inside(DAY),
      money_out_24h: outside(DAY),
      money_in_7d: inside(7 * DAY),
      money_out_7d: outside(7 * DAY),
      money_in_90d: inside(90 * DAY),
      money_out_90d: outside(90 * DAY),
    };
  }
  // The same facts with the arithmetic done: how unusual the money in is, and how much of the
  // withdrawal it pays for.
  const week = inside(7 * DAY).sum;
  const usualWeek = (inside(90 * DAY).sum - week) / (83 / 7);
  const pendingUsd = Number(c.pending_action.usd ?? 0);
  return {
    money_in_last_7_days_against_a_usual_week:
      usualWeek > 0 ? `${Math.round((10 * week) / usualWeek) / 10} times` : week > 0 ? "no earlier deposits" : "none",
    share_of_this_withdrawal_that_money_in_during_last_7_days_covers:
      pendingUsd > 0 ? Math.min(1, Math.round((100 * week) / pendingUsd) / 100) : null,
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
  live ??= createGraysonClient({ apiKey: process.env.GRAYSON_API_KEY!, timeoutMs: 60_000, maxRetries: 3 });
  const response = await live(request);
  calls++;
  writeFileSync(`${dir}/${hash}.json`, JSON.stringify(response));
  return response;
};

interface Result {
  probability: number;
  outcome: string;
  deposit_spike: number;
  pass_through: number;
}

async function run(c: Case, variant: Variant): Promise<Result> {
  const base = buildContext({
    subject: { type: "user", ...c.account },
    events: c.events,
    pendingAction: c.pending_action as never,
    linkedEntities: c.linked_entities,
  });
  const { subject, baseline_of_older_events, ...rest } = base;
  // The totals go after the summary of older events, where the proposal puts them.
  const context =
    variant === "none" ? base : { subject, baseline_of_older_events, totals: totals(c, variant), ...rest };
  const raw = await decider({ model: "grayson-1", context, questions: buildQuestions(WITHDRAWAL_ACTION) });
  const hold = raw.answers.hold as { probability: number };
  const reasons = (raw.answers.reasons as { probabilities: Record<string, number> }).probabilities;
  const present = Object.entries(reasons)
    .filter(([, p]) => p >= 0.5)
    .map(([code]) => code);
  return {
    probability: hold.probability,
    outcome: applyPolicy(actionPolicy(WITHDRAWAL_ACTION), hold.probability, present).decision,
    deposit_spike: reasons.deposit_spike ?? 0,
    pass_through: reasons.pass_through ?? 0,
  };
}

const VARIANTS: Variant[] = ["none", "sums", "ratios", "built"];
async function runAll(cases: Case[]) {
  const rows: { c: Case; r: Record<Variant, Result> }[] = [];
  for (let i = 0; i < cases.length; i += 2) {
    rows.push(
      ...(await Promise.all(
        cases.slice(i, i + 2).map(async (c) => ({
          c,
          r: {
            none: await run(c, "none"),
            sums: await run(c, "sums"),
            ratios: await run(c, "ratios"),
            built: await run(c, "built"),
          },
        })),
      )),
    );
  }
  return rows;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0).toFixed(2);
const held = (r: Result) => r.outcome === "review" || r.outcome === "block";
function summary(rows: Awaited<ReturnType<typeof runAll>>) {
  for (const variant of VARIANTS) {
    const pos = rows.filter((x) => x.c.label === 1).map((x) => x.r[variant]);
    const neg = rows.filter((x) => x.c.label === 0).map((x) => x.r[variant]);
    let wins = 0;
    for (const p of pos)
      for (const q of neg) wins += p.probability > q.probability ? 1 : p.probability === q.probability ? 0.5 : 0;
    console.log(
      `${variant.padEnd(7)} catch rate ${(pos.filter((r) => r.outcome !== "approve").length / pos.length).toFixed(3)}` +
        `  held by score ${(pos.filter(held).length / pos.length).toFixed(3)}` +
        `  false-action rate ${(neg.filter((r) => r.outcome !== "approve").length / neg.length).toFixed(3)}` +
        `  false holds ${String(neg.filter(held).length).padStart(2)}  AUC ${(wins / (pos.length * neg.length)).toFixed(3)}`,
    );
  }
}
function byKind(rows: Awaited<ReturnType<typeof runAll>>, kinds: readonly string[]) {
  console.log(
    "kind                  n   hold probability             held                  deposit_spike              pass_through",
  );
  console.log(
    "                          none  sums ratios built     none sums ratios built none  sums ratios built    none  sums ratios built",
  );
  for (const kind of kinds) {
    const k = rows.filter((x) => x.c.kind === kind);
    if (k.length === 0) continue;
    const col = (pick: (r: Result) => number) =>
      VARIANTS.map((v) => mean(k.map((x) => pick(x.r[v]))).padStart(5)).join(" ");
    const n = VARIANTS.map((v) => String(k.filter((x) => held(x.r[v])).length).padStart(4)).join(" ");
    console.log(
      `${kind.padEnd(20)} ${String(k.length).padStart(2)}  ${col((r) => r.probability)}      ${n}    ${col((r) => r.deposit_spike)}    ${col((r) => r.pass_through)}`,
    );
  }
}

/** How many cases report both money signals. A rule on the two signals would act on these. */
function bothSignals(rows: Awaited<ReturnType<typeof runAll>>, kinds: readonly string[]) {
  console.log("\ncases where deposit_spike and pass_through are both reported (0.5 or more)");
  console.log("kind                  n   none sums ratios built");
  for (const kind of kinds) {
    const k = rows.filter((x) => x.c.kind === kind);
    console.log(
      `${kind.padEnd(20)} ${String(k.length).padStart(2)}  ${VARIANTS.map((v) => String(k.filter((x) => x.r[v].deposit_spike >= 0.5 && x.r[v].pass_through >= 0.5).length).padStart(4)).join(" ")}`,
    );
  }
}

const buried = NEW_KINDS.flatMap((kind) => Array.from({ length: 10 }, (_, i) => makeCase(kind, i)));
const sample = buried[0]!;
const split = sample.events.length - 30;
const inRecent = sample.events.slice(split).filter((e) => e.type === "deposit_bank").length;
console.log(
  `${buried.length} long-history cases, ${sample.events.length} events in the first. Deposits among its last 30 events: ${inRecent}.\n`,
);

const first = await runAll(buried);
console.log("LONG HISTORIES: the signal is only in events older than the recent 30\n");
byKind(first, NEW_KINDS);
console.log();
summary(first);
bothSignals(first, NEW_KINDS);
console.log("\nexample, mule_fast-00");
console.log("  sums:  ", JSON.stringify(totals(sample, "sums")));
console.log("  ratios:", JSON.stringify(totals(sample, "ratios")));
console.log("  built: ", JSON.stringify(totals(sample, "built")));
const honest = buried.find((c) => c.kind === "honest_old_money")!;
console.log("example, honest_old_money-00");
console.log("  sums:  ", JSON.stringify(totals(honest, "sums")));
console.log("  ratios:", JSON.stringify(totals(honest, "ratios")));
console.log("  built: ", JSON.stringify(totals(honest, "built")));

const accepted: Case[] = readFileSync(here("cases/v1.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const second = await runAll(accepted);
console.log("\n\nACCEPTED CASES (cases/v1.jsonl): the signal is in the recent events already\n");
byKind(second, [...new Set(accepted.map((c) => c.kind))]);
console.log();
summary(second);
bothSignals(second, [...new Set(accepted.map((c) => c.kind))]);
console.log(`\n${calls} new model calls`);
