/**
 * Experiment: what do the automatic events of the SDK middleware do to the decisions?
 *
 * The middleware of `@finic-ai/kairos/middleware` sends an event for a route when its response
 * finishes: `password_changed` for `PUT /account/password`. Such an event has the entities of
 * the request and four properties (`source`, `http_method`, `http_route`, `http_status`), and
 * nothing from the request body. The question has three parts, one for each arm:
 *
 *   with_session       the cases as they are, with the session block: every account change
 *                      was tracked by hand, with its data (from the cache of the
 *                      session-block experiment)
 *   not_tracked        the account changes are missing: what a decision sees when nobody
 *                      wrote the `track` calls. This is what the middleware is for.
 *   automatic          the account changes as the middleware sends them: the fact and the
 *                      device, without the data (the address, the country, the setting)
 *   with_properties    the events as they are, with the four properties added: what a route
 *                      with a `properties` function sends. Do the four properties cost anything?
 *
 *   GRAYSON_API_KEY=... pnpm --filter @kairos/eval exec tsx --env-file-if-exists=../../.env src/experiments/automatic-events.ts
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
  type KairosEvent,
} from "@kairos/core";
import type { EvalCase } from "../generate";
import { CASES_FILE, summarise, type Row } from "../report";
import { WITHDRAWAL_ACTION } from "../withdrawal";

const here = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

let live: Decider | undefined;
/** Reads `caches` in order, and writes a new answer to the first. */
function decider(caches: string[], stats: { hits: number; calls: number }): Decider {
  mkdirSync(caches[0]!, { recursive: true });
  return async (request) => {
    const name = `${createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32)}.json`;
    const found = caches.map((cache) => `${cache}/${name}`).find((file) => existsSync(file));
    if (found) {
      stats.hits++;
      return JSON.parse(readFileSync(found, "utf8"));
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
    writeFileSync(`${caches[0]}/${name}`, JSON.stringify(response));
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

/**
 * The account changes of the cases, and the route each would have in an application. These
 * are the events a route map is for: the fact is most of what they say.
 */
const ROUTES: Record<string, [method: string, route: string, status: string]> = {
  password_reset_requested: ["POST", "/password-reset", "202"],
  password_reset_completed: ["POST", "/password-reset/confirm", "204"],
  two_factor_method_changed: ["PUT", "/account/two-factor", "204"],
  two_factor_reenrolled: ["POST", "/account/two-factor", "201"],
  two_factor_disabled: ["DELETE", "/account/two-factor", "204"],
  notification_settings_changed: ["PUT", "/account/notifications", "204"],
  withdrawal_address_added: ["POST", "/withdrawal-addresses", "201"],
  withdrawal_limit_increase_requested: ["POST", "/account/withdrawal-limit", "202"],
  login_failed: ["POST", "/login", "401"],
};
const sent = (type: string) => {
  const [http_method, http_route, http_status] = ROUTES[type]!;
  return { source: "auto", http_method, http_route, http_status };
};

const WITH_SESSION = here("experiments/cache/session-block/with_session");
const ARMS = {
  with_session: { cache: WITH_SESSION, events: (events: KairosEvent[]) => events },
  not_tracked: {
    cache: here("experiments/cache/automatic-events/not_tracked"),
    events: (events: KairosEvent[]) => events.filter((e) => !(e.type in ROUTES)),
  },
  // The request gives the device. The rest of the event was in the body, which the middleware does not read.
  automatic: {
    cache: here("experiments/cache/automatic-events/automatic"),
    events: (events: KairosEvent[]) =>
      events.map((e): KairosEvent =>
        e.type in ROUTES
          ? { ts: e.ts, type: e.type, ...(e.device !== undefined ? { device: e.device } : {}), ...sent(e.type) }
          : e,
      ),
  },
  with_properties: {
    cache: here("experiments/cache/automatic-events/with_properties"),
    events: (events: KairosEvent[]) =>
      events.map((e): KairosEvent => (e.type in ROUTES ? { ...e, ...sent(e.type) } : e)),
  },
} satisfies Record<string, { cache: string; events: (events: KairosEvent[]) => KairosEvent[] }>;
type Arm = keyof typeof ARMS;

async function run(arm: Arm) {
  const action: ActionDefinition = WITHDRAWAL_ACTION;
  const stats = { hits: 0, calls: 0 };
  // A case with no account change is the same request in every arm.
  const call = decider([...new Set([ARMS[arm].cache, WITH_SESSION])], stats);
  const rows = await mapLimit(cases, 2, async (c): Promise<Row & { hold: number }> => {
    const events = ARMS[arm].events(c.events);
    const wanted = action.context?.totals ?? [];
    const requested = String(c.pending_action.requested_at);
    const at = Date.parse(requested.length === 16 ? `${requested}:00Z` : requested);
    const totals = wanted.length ? evaluateTotals(wanted, events, c.pending_action, at) : undefined;
    const visit = summariseSession(sessionOf(events), at);
    const { decision, raw } = await decide(
      {
        ...(visit ? { session: visit.context } : {}),
        subject: { type: "user", ...c.account },
        events,
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

const touched = cases.filter((c) => c.events.some((e) => e.type in ROUTES)).length;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const base = results.with_session;
console.log(
  `\nEach way against the cases as they are, over the same ${cases.length} cases. ${touched} of them have an account change.\n`,
);
console.log(
  "way              catch   false-action  typology  reasons right | hold probability: mean |Δ|   max |Δ|   |Δ|>0.05 | decision changed  tokens",
);
for (const arm of Object.keys(ARMS) as Arm[]) {
  const rows = results[arm];
  const s = summarise(rows);
  const delta = rows.map((r, i) => Math.abs(r.hold - base[i]!.hold));
  console.log(
    [
      arm.padEnd(16),
      pct(s.catch_rate).padStart(6),
      pct(s.false_action_rate).padStart(11),
      pct(rows.filter((r) => r.typologyOk).length / rows.length).padStart(10),
      pct(s.reason_fact_accuracy).padStart(13),
      " | ",
      (delta.reduce((a, b) => a + b, 0) / delta.length).toFixed(4).padStart(26),
      Math.max(...delta)
        .toFixed(4)
        .padStart(9),
      String(delta.filter((d) => d > 0.05).length).padStart(9),
      " | ",
      String(rows.filter((r, i) => r.decision.decision !== base[i]!.decision.decision).length).padStart(15),
      String(Math.round(s.mean_tokens)).padStart(7),
    ].join(" "),
  );
}

const kinds = [...new Set(cases.map((c) => c.kind))];
const arms = Object.keys(ARMS) as Arm[];
console.log(`\nNot approved, by kind: ${arms.join(" · ")}`);
for (const kind of kinds) {
  const actioned = (arm: Arm) =>
    results[arm].filter((r) => r.kind === kind && r.decision.decision !== "approve").length;
  const of = cases.filter((c) => c.kind === kind).length;
  console.log(
    `  ${kind.padEnd(22)} label ${cases.find((c) => c.kind === kind)!.label}   ${arms.map((arm) => `${actioned(arm)}/${of}`).join(" · ")}`,
  );
}

for (const arm of arms.slice(1)) {
  const changed = results[arm]
    .map((r, i) => ({ r, was: base[i]! }))
    .filter(({ r, was }) => r.decision.decision !== was.decision.decision);
  console.log(`\n${arm}: decisions that changed`);
  for (const { r, was } of changed)
    console.log(
      `  ${r.id.padEnd(24)} label ${r.label}  ${was.decision.decision} (${was.hold.toFixed(3)}) → ${r.decision.decision} (${r.hold.toFixed(3)})`,
    );
  if (changed.length === 0) console.log("  none");
}
writeFileSync(
  here("experiments/cache/automatic-events/result.json"),
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
