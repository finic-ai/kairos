/**
 * Replays the evaluation cases through a running Kairos server with the SDK, the way a
 * customer would send them: events, objects and labels in, then decide.
 *
 *   pnpm api             (in another terminal)
 *   pnpm eval:replay
 *
 * The cases describe links as counts ("device shared with 6 other accounts, 3 reported").
 * The server derives links from events, so the replay first creates those other users.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WITHDRAWAL_ACTION } from "./withdrawal";
import { Kairos } from "../../sdk/src/index.js";
import type { EvalCase } from "./generate";
import { CASES_FILE, print, summarise, type Row, type Summary } from "./report";

const here = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const DAY = 86_400_000;
const iso = (ts: string) => (ts.length === 16 ? `${ts}:00Z` : ts);

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY ?? missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  flushAt: 500,
  decideTimeoutMs: 30_000,
  onError: (error) => console.error("delivery failed:", error.message),
});

/** Create the other users that a case's link counts describe. */
async function peers(c: EvalCase, now: number) {
  const labelled: { id: string; label: string }[] = [];
  for (const [key, block] of Object.entries(c.linked_entities)) {
    const [type, id] = key.split(" ") as [string, string];
    const b = block as Record<string, number | string>;
    if (type === "device") {
      for (let i = 0; i < Number(b.other_accounts); i++) {
        const user = `${c.id}_device_peer_${i}`;
        const recent = i < Number(b.other_accounts_opened_last_30_days);
        kairos.track("login", {
          userId: user,
          entities: { device: id },
          timestamp: new Date(now - (recent ? 10 + i : 200 + i) * DAY),
        });
        if (i < Number(b.other_accounts_with_fraud_or_takeover_report))
          labelled.push({ id: user, label: "fraud_or_takeover_report" });
      }
    } else {
      const firstSeen = Date.parse(iso(String(b.first_seen_on_platform)));
      for (let i = 0; i < Number(b.other_senders_last_30_days); i++) {
        const user = `${c.id}_destination_peer_${i}`;
        // The first sender carries the address's first-seen date; the rest are spread over the last month.
        const when = i === 0 && !Number.isNaN(firstSeen) ? Math.min(firstSeen, now - DAY) : now - (1 + (i % 28)) * DAY;
        kairos.track("withdrawal_crypto", {
          userId: user,
          entities: { destination: id },
          usd: 500 + 100 * i,
          timestamp: new Date(when),
        });
        if (!Number.isNaN(firstSeen) && i === 0 && firstSeen < now - 30 * DAY) {
          kairos.track("withdrawal_crypto", {
            userId: user,
            entities: { destination: id },
            usd: 400,
            timestamp: new Date(now - 3 * DAY),
          });
        }
        if (i < Number(b.other_senders_with_scam_or_fraud_report))
          labelled.push({ id: user, label: "scam_or_fraud_report" });
      }
    }
  }
  await kairos.flush();
  // The outcome was known before the decision: a label from after it would not be seen.
  for (const { id, label } of labelled)
    await kairos.label({ type: "user", id }, label, {}, { timestamp: new Date(now - DAY) });
}

async function replay(c: EvalCase): Promise<Row & { ms: number }> {
  const now = Date.parse(iso(String(c.pending_action.requested_at)));
  await kairos.setObject("user", c.id, c.account);

  let device = "";
  c.events.forEach((event, i) => {
    const { ts, type, device: d, destination, address, ...properties } = event as Record<string, any>;
    const entities: Record<string, string> = {};
    if (d) entities.device = device = d;
    if (destination ?? address) entities.destination = destination ?? address;
    kairos.track(type, { userId: c.id, entities, ...properties, timestamp: iso(ts), eventId: `${c.id}_${i}` });
  });
  await peers(c, now);

  const { type: _t, destination, requested_at: _r, ...properties } = c.pending_action as Record<string, any>;
  const started = Date.now();
  const d = await kairos.decide(
    { type: "withdrawal", userId: c.id, entities: { destination, device }, ...properties },
    { timestamp: new Date(now) },
  );
  const scored = Object.entries(c.facts).filter(([, truth]) => truth !== null);
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    decision: {
      decision: d.decision,
      probability: d.probability,
      risk_score: d.riskScore,
      reasons: d.reasons,
      typology: d.typology,
      rules: d.rules,
      action: d.action ?? "",
    },
    typologyOk: d.typology === c.expected_typology,
    factsRight: scored.filter(([code, truth]) => d.reasons.includes(code) === truth).length,
    factsScored: scored.length,
    tokens: 0,
    ms: Date.now() - started,
  };
}

const cases: EvalCase[] = readFileSync(here(`cases/${CASES_FILE}`), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const { name, ...definition } = WITHDRAWAL_ACTION;
const action = await kairos.defineAction(name, definition);
console.log(
  `Replaying ${cases.length} cases through ${process.env.KAIROS_URL || "http://localhost:8787"} with action ${action.name}@${action.version}`,
);

const rows: (Row & { ms: number })[] = [];
for (const c of cases) {
  rows.push(await replay(c));
  if (rows.length % 20 === 0) console.log(`  ${rows.length} decided`);
}
await kairos.shutdown();

const accepted: Summary | null = existsSync(here("accepted.json"))
  ? JSON.parse(readFileSync(here("accepted.json"), "utf8"))
  : null;
console.log("\nDifferences in brackets are against the library run in accepted.json.");
print(summarise(rows), accepted);
const times = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(
  `decide() time through SDK and server: median ${times[Math.floor(times.length / 2)]} ms, p90 ${times[Math.floor(times.length * 0.9)]} ms, max ${times.at(-1)} ms`,
);
console.log(
  `events sent: ${cases.reduce((a, c) => a + c.events.length, 0)} for the ${cases.length} subjects, plus their linked users`,
);

/** A secret key is made in the console: Settings › API keys. */
function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
