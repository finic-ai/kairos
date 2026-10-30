/**
 * Experiment: does a "this session" block in the context change the decisions?
 *
 * With `$session`, a decision knows which of the subject's recent events are the current
 * visit. The context then gets a block with the start of the session, how long ago that was,
 * and its steps in order. The 100 accepted cases carry no session ids, so a session here is
 * what a customer's server would send: the events from the last login to the request.
 *
 *   written         the request as it is today (from the cache of the evaluation suite)
 *   written_again   the same request, sent again: how much the model varies by itself
 *                   (from the cache of the key-order experiment)
 *   with_session    the same request with the block
 *
 *   GRAYSON_API_KEY=... pnpm --filter @kairos/eval exec tsx src/experiments/session-block.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createGraysonClient,
  GraysonError,
  decide,
  evaluateTotals,
  summariseSession,
  type ActionDefinition,
  type Decider,
  type Decision,
  type KairosEvent,
} from "@kairos/core";
import type { EvalCase } from "../generate";
import { CASES_FILE, summarise, type Row } from "../report";
import { WITHDRAWAL_ACTION } from "../withdrawal";

const here = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

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

/** The events of the visit the request is made in: from the last login on. */
function sessionOf(events: KairosEvent[]): KairosEvent[] {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const login = sorted.map((e) => e.type).lastIndexOf("login");
  return login < 0 ? [] : sorted.slice(login);
}

const ARMS = {
  written: { cache: here("cache"), session: false },
  written_again: { cache: here("experiments/cache/key-order/written_again"), session: false },
  with_session: { cache: here("experiments/cache/session-block/with_session"), session: true },
} satisfies Record<string, { cache: string; session: boolean }>;
type Arm = keyof typeof ARMS;

async function run(arm: Arm) {
  const { cache, session } = ARMS[arm];
  const action: ActionDefinition = WITHDRAWAL_ACTION;
  const stats = { hits: 0, calls: 0 };
  let withSession = 0;
  const call = decider(cache, stats);
  const rows = await mapLimit(cases, 2, async (original): Promise<Row & { hold: number }> => {
    const c = original;
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
    const at = Date.parse(requested.length === 16 ? `${requested}:00Z` : requested);
    const visit = session ? summariseSession(sessionOf(c.events), at) : null;
    if (visit) withSession++;
    const { decision, raw } = await decide(
      {
        ...(visit ? { session: visit.context } : {}),
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
  console.error(
    `${arm}: ${stats.hits} cached, ${stats.calls} new model calls${session ? `, ${withSession} cases with a session` : ""}`,
  );
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
const kinds = [...new Set(cases.map((c) => c.kind))];
console.log("\nHeld (review or block) by kind: written → with_session, and tokens");
for (const kind of kinds) {
  const held = (arm: Arm) =>
    results[arm].filter((r) => r.kind === kind && (r.decision.decision === "review" || r.decision.decision === "block"))
      .length;
  const of = cases.filter((c) => c.kind === kind).length;
  console.log(
    `  ${kind.padEnd(22)} label ${cases.find((c) => c.kind === kind)!.label}   ${held("written")}/${of} → ${held("with_session")}/${of}`,
  );
}
const tokens = (arm: Arm) => Math.round(results[arm].reduce((sum, r) => sum + r.tokens, 0) / results[arm].length);
console.log(`\nInput tokens for a decision, on average: ${tokens("written")} → ${tokens("with_session")}`);

const changed = (arm: Arm) =>
  results[arm]
    .map((r, i) => ({ r, was: base[i]! }))
    .filter(({ r, was }) => r.decision.decision !== was.decision.decision);
for (const arm of ["written_again", "with_session"] as Arm[]) {
  console.log(`\n${arm}: decisions that changed`);
  for (const { r, was } of changed(arm))
    console.log(
      `  ${r.id.padEnd(24)} label ${r.label}  ${was.decision.decision} (${was.hold.toFixed(3)}) → ${r.decision.decision} (${r.hold.toFixed(3)})`,
    );
  if (changed(arm).length === 0) console.log("  none");
}
writeFileSync(
  here("experiments/cache/session-block/result.json"),
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
