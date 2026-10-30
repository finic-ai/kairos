/**
 * Experiment: does the order of object keys change what the model answers?
 *
 * Postgres `jsonb` does not keep the order of the keys of an object: it stores them shortest
 * first, then byte by byte. With `jsonb` columns, an action's reason codes and typologies,
 * the properties of an event and the properties of an entity reach the model in that order
 * and not in the order they were written. This runs the 100 accepted cases four ways:
 *
 *   written         the request as it is today (from the cache of the evaluation suite)
 *   written_again   the same request, sent again: how much the model varies by itself
 *   action_sorted   the action definition in jsonb order
 *   all_sorted      the action, the events and the account in jsonb order
 *
 * The model does not give the same probability twice for one request, so a difference means
 * something only when it is larger than the difference between the first two.
 *
 *   GRAYSON_API_KEY=... pnpm --filter @kairos/eval exec tsx src/experiments/key-order.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createGraysonClient,
  GraysonError,
  decide,
  evaluateTotals,
  type ActionDefinition,
  type Decider,
  type Decision,
} from "@kairos/core";
import type { EvalCase } from "../generate";
import { CASES_FILE, summarise, type Row } from "../report";
import { WITHDRAWAL_ACTION } from "../withdrawal";

const here = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** The order jsonb gives the keys of an object: shorter first, then by bytes. Arrays keep their order. */
const jsonbOrder = (a: string, b: string) =>
  Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b));
function asJsonb<T>(value: T): T {
  if (Array.isArray(value)) return value.map(asJsonb) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(jsonbOrder)
      .map((key) => [key, asJsonb((value as Record<string, unknown>)[key])]),
  ) as T;
}
/** An event from the store: the time and the type are columns, the rest is one jsonb value. */
const eventAsStored = <E extends { ts: unknown; type: unknown }>({ ts, type, ...rest }: E) =>
  ({ ts, type, ...asJsonb(rest) }) as unknown as E;

let live: Decider | undefined;
function decider(cache: string, stats: { hits: number; calls: number }): Decider {
  mkdirSync(cache, { recursive: true });
  return async (request) => {
    const file = `${cache}/${createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32)}.json`;
    if (existsSync(file)) {
      stats.hits++;
      return JSON.parse(readFileSync(file, "utf8"));
    }
    live ??= createGraysonClient({ apiKey: process.env.GRAYSON_API_KEY!, timeoutMs: 60_000, maxRetries: 3 });
    // The organization may send 5 requests a second. Past that, wait and send again.
    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await live(request);
        break;
      } catch (cause) {
        if (!(cause instanceof GraysonError) || cause.status !== 429 || attempt >= 7) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** Math.min(attempt, 4)));
      }
    }
    stats.calls++;
    writeFileSync(file, JSON.stringify(response));
    return response;
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const cases: EvalCase[] = readFileSync(here(`cases/${CASES_FILE}`), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const ARMS = {
  written: { cache: here("cache"), action: WITHDRAWAL_ACTION, data: (c: EvalCase) => c },
  written_again: {
    cache: here("experiments/cache/key-order/written_again"),
    action: WITHDRAWAL_ACTION,
    data: (c: EvalCase) => c,
  },
  action_sorted: {
    cache: here("experiments/cache/key-order/action_sorted"),
    action: asJsonb(WITHDRAWAL_ACTION),
    data: (c: EvalCase) => c,
  },
  all_sorted: {
    cache: here("experiments/cache/key-order/all_sorted"),
    action: asJsonb(WITHDRAWAL_ACTION),
    data: (c: EvalCase): EvalCase => ({ ...c, account: asJsonb(c.account), events: c.events.map(eventAsStored) }),
  },
} satisfies Record<string, { cache: string; action: ActionDefinition; data: (c: EvalCase) => EvalCase }>;
type Arm = keyof typeof ARMS;

async function run(arm: Arm) {
  const { cache, action, data } = ARMS[arm];
  const stats = { hits: 0, calls: 0 };
  const call = decider(cache, stats);
  const rows = await mapLimit(cases, 2, async (original): Promise<Row & { hold: number }> => {
    const c = data(original);
    const wanted = action.context?.totals ?? [];
    const requested = String(c.pending_action.requested_at);
    const totals = wanted.length
      ? evaluateTotals(
          wanted,
          c.events,
          c.pending_action,
          Date.parse(requested.length === 16 ? `${requested}:00Z` : requested),
        )
      : undefined;
    const { decision, raw } = await decide(
      {
        subject: { type: "user", ...c.account },
        events: c.events,
        pendingAction: c.pending_action,
        linkedEntities: c.linked_entities,
        ...(totals ? { totals: totals.context, totalValues: totals.values } : {}),
      },
      { decider: call, action },
    );
    const scored = Object.entries(c.facts).filter(([, truth]) => truth !== null);
    return {
      id: c.id,
      kind: c.kind,
      label: c.label,
      decision,
      hold: decision.probability,
      typologyOk: decision.typology === c.expected_typology,
      factsRight: scored.filter(([code, truth]) => decision.reasons.includes(code) === truth).length,
      factsScored: scored.length,
      tokens: raw.usage.input_tokens,
    };
  });
  console.error(`${arm}: ${stats.hits} cached, ${stats.calls} new model calls`);
  return rows;
}

const results = {} as Record<Arm, Awaited<ReturnType<typeof run>>>;
for (const arm of Object.keys(ARMS) as Arm[]) results[arm] = await run(arm);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const same = (a: Decision, b: Decision) => [...a.reasons].sort().join() === [...b.reasons].sort().join();
const base = results.written;
console.log("\nEach way against the request as written, over the same 100 cases\n");
console.log(
  "way            catch   false-action  typology  | hold probability: mean |Δ|   max |Δ|   |Δ|>0.05 | decision changed  typology changed  reasons changed",
);
for (const arm of Object.keys(ARMS) as Arm[]) {
  const rows = results[arm];
  const s = summarise(rows);
  const delta = rows.map((r, i) => Math.abs(r.hold - base[i]!.hold));
  const count = (test: (r: (typeof rows)[number], i: number) => boolean) => rows.filter(test).length;
  console.log(
    [
      arm.padEnd(14),
      pct(s.catch_rate).padStart(6),
      pct(s.false_action_rate).padStart(11),
      pct(rows.filter((r) => r.typologyOk).length / rows.length).padStart(10),
      " | ",
      (delta.reduce((a, b) => a + b, 0) / delta.length).toFixed(4).padStart(26),
      Math.max(...delta)
        .toFixed(4)
        .padStart(9),
      String(delta.filter((d) => d > 0.05).length).padStart(9),
      " | ",
      String(count((r, i) => r.decision.decision !== base[i]!.decision.decision)).padStart(15),
      String(count((r, i) => r.decision.typology !== base[i]!.decision.typology)).padStart(17),
      String(count((r, i) => !same(r.decision, base[i]!.decision))).padStart(16),
    ].join(" "),
  );
}
const changed = (arm: Arm) =>
  results[arm]
    .map((r, i) => ({ r, was: base[i]! }))
    .filter(({ r, was }) => r.decision.decision !== was.decision.decision);
for (const arm of ["written_again", "action_sorted", "all_sorted"] as Arm[]) {
  console.log(`\n${arm}: decisions that changed`);
  for (const { r, was } of changed(arm))
    console.log(
      `  ${r.id.padEnd(24)} label ${r.label}  ${was.decision.decision} (${was.hold.toFixed(3)}) → ${r.decision.decision} (${r.hold.toFixed(3)})`,
    );
  if (changed(arm).length === 0) console.log("  none");
}
writeFileSync(
  here("experiments/cache/key-order/result.json"),
  JSON.stringify(
    Object.fromEntries(
      Object.entries(results).map(([arm, rows]) => [
        arm,
        rows.map(({ id, label, decision }) => ({ id, label, ...decision })),
      ]),
    ),
    null,
    1,
  ),
);
