/**
 * Runs every case through the decision path and reports the catch rate and the
 * false-action rate. Model responses are cached by request hash, so a run with no change
 * to the context, questions or cases needs no API key and makes no calls. The model does
 * not always give the same probability for the same request (see the README), so the
 * cache is what makes a run repeatable.
 *
 *   pnpm eval            run and compare with accepted.json
 *   pnpm eval:accept     run and store the result as the new accepted baseline
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateTotals, createGraysonClient, decide, type Decider } from "@kairos/core";
import { WITHDRAWAL_ACTION } from "./withdrawal";
import type { EvalCase } from "./generate";
import { CASES_FILE, print, summarise, type Row, type Summary } from "./report";
const here = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

function cachedDecider(): { decider: Decider; stats: { hits: number; calls: number } } {
  const dir = here("cache");
  mkdirSync(dir, { recursive: true });
  const stats = { hits: 0, calls: 0 };
  let live: Decider | undefined;
  const decider: Decider = async (request) => {
    const file = `${dir}/${createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32)}.json`;
    if (existsSync(file)) {
      stats.hits++;
      return JSON.parse(readFileSync(file, "utf8"));
    }
    const apiKey = process.env.GRAYSON_API_KEY;
    if (!apiKey) throw new Error("A request is not in the cache. Set GRAYSON_API_KEY to call Grayson.");
    live ??= createGraysonClient({ apiKey, timeoutMs: 60_000 });
    const response = await live(request);
    stats.calls++;
    writeFileSync(file, JSON.stringify(response));
    return response;
  };
  return { decider, stats };
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

async function main() {
  const cases: EvalCase[] = readFileSync(here(`cases/${CASES_FILE}`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const { decider, stats } = cachedDecider();

  const rows = await mapLimit(cases, 2, async (c): Promise<Row> => {
    // The server calculates an action's totals from the stored events. Here the events are the case.
    const wanted = WITHDRAWAL_ACTION.context?.totals ?? [];
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
      { decider, action: WITHDRAWAL_ACTION },
    );
    const scored = Object.entries(c.facts).filter(([, truth]) => truth !== null);
    return {
      id: c.id,
      kind: c.kind,
      label: c.label,
      decision,
      typologyOk: decision.typology === c.expected_typology,
      factsRight: scored.filter(([code, truth]) => decision.reasons.includes(code) === truth).length,
      factsScored: scored.length,
      tokens: raw.usage.input_tokens,
    };
  });

  const summary = summarise(rows);
  const acceptedPath = here("accepted.json");
  const accepted: Summary | null = existsSync(acceptedPath) ? JSON.parse(readFileSync(acceptedPath, "utf8")) : null;
  print(summary, accepted);
  console.log(`\n${stats.hits} cached, ${stats.calls} new model calls`);

  writeFileSync(
    here("last-run.json"),
    JSON.stringify({ summary, rows: rows.map(({ id, decision }) => ({ id, ...decision })) }, null, 1),
  );
  if (process.argv.includes("--accept")) {
    writeFileSync(acceptedPath, JSON.stringify(summary, null, 2) + "\n");
    console.log("Stored as accepted.json");
  } else if (
    accepted &&
    (summary.catch_rate < accepted.catch_rate || summary.false_action_rate > accepted.false_action_rate)
  ) {
    console.log("\nREGRESSION against accepted.json");
    process.exitCode = 1;
  }
}

await main();
