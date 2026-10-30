/**
 * Money mules at a cash machine: when is a shared place a link?
 *
 *   pnpm api
 *   pnpm example:atm
 *
 * Honest customers and mules use the same busy ATM, so "used the same ATM" means
 * nothing by itself. What does mean something is concentration: a share of recent users
 * with a mule label far above the normal share, or several new accounts at the machine
 * within minutes of each other. The link summary reports both, and this example checks
 * whether that is enough to tell the two groups apart.
 *
 *   mule_flagged_atm     a new account cashes out a transfer at an ATM where earlier
 *                        ring members were already confirmed as mules
 *   mule_unflagged_atm   the same behaviour at an ATM where nobody is labelled yet:
 *                        only the burst of new accounts gives it away
 *   honest_regular       an established customer takes out the usual amount at the
 *                        flagged ATM
 *   honest_new_account   a new customer, paid by an employer, at the flagged ATM
 *   honest_large_cash    an established customer takes out the daily limit at the
 *                        flagged ATM, after saying why
 *   honest_quiet_atm     an established customer at an ATM with no mule activity
 *
 * Every withdrawal is decided twice: once with every entity type as a link, and once
 * with `linkTypes: ["device"]`, where the ATM is not a link. No policy rules are used,
 * so the numbers are the model's alone. The decisions are made in the order the
 * withdrawals arrive, so the first mule at the unflagged ATM has nothing to be linked to.
 *
 * All data is synthetic and written for this example.
 */
import { Rng } from "../packages/eval/src/rng";
import { Kairos, type Decision } from "../packages/sdk/src/index.js";
import { template } from "../templates/index";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY ?? missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  flushAt: 500,
  maxQueueSize: 200_000,
  decideTimeoutMs: 30_000,
  onError: (error) => console.error("delivery failed:", error.message),
});

// Event ids are stable, so running the example twice does not store the events twice.
let sequence = 0;
const send = kairos.track.bind(kairos);
kairos.track = (type, properties = {}) => send(type, { eventId: `atm_${++sequence}`, ...properties });

const r = new Rng(4242);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const START = Date.now();
const ago = (ms: number) => new Date(START - ms);
const daysAgo = (days: number, hour = r.int(8, 21)) =>
  new Date(Math.floor((START - days * DAY) / DAY) * DAY + hour * 60 * MIN + r.int(0, 59) * MIN);

const FLAGGED_ATM = "atm_central_14";
const UNFLAGGED_ATM = "atm_station_22";
const QUIET_ATM = "atm_parkside_03";
const SHOPS = [
  "greenleaf_grocery",
  "metro_fuel",
  "corner_coffee",
  "streambox",
  "quickbite_delivery",
  "northside_pharmacy",
];
const CARD_LIMIT = 800;

let serial = 0;
const next = (prefix: string) => `${prefix}_${String(++serial).padStart(4, "0")}`;

interface Customer {
  id: string;
  device: string;
}

/** An established customer: payroll, card spend, and a cash withdrawal now and then at `atm`. */
function established(atm: string, days = 60): Customer {
  const c = { id: next("atmcust"), device: next("atmdev") };
  const pay = r.pick([1800, 2300, 2900, 3600]);
  for (let d = days; d > 0; d--) {
    if (r.chance(0.35)) kairos.track("login", { userId: c.id, entities: { device: c.device }, timestamp: daysAgo(d) });
    if (r.chance(0.5))
      kairos.track("card_payment", {
        userId: c.id,
        entities: { merchant: r.pick(SHOPS) },
        usd: r.int(6, 90),
        timestamp: daysAgo(d),
      });
    if (d % 14 === 3)
      kairos.track("ach_deposit", { userId: c.id, usd: pay, source: "payroll", timestamp: daysAgo(d, 6) });
    if (r.chance(0.045))
      kairos.track("atm_withdrawal", {
        userId: c.id,
        entities: { atm },
        usd: r.pick([40, 60, 80, 100, 160, 200]),
        timestamp: daysAgo(d),
      });
  }
  // Everyone in the population used their ATM at least once in the month.
  kairos.track("atm_withdrawal", {
    userId: c.id,
    entities: { atm },
    usd: r.pick([40, 60, 100]),
    timestamp: daysAgo(r.int(1, 28)),
  });
  return c;
}

/** A mule account: opened days ago, receives a transfer from a stranger, cashes it out at once. */
function mule(openedDaysAgo: number): Customer {
  const c = { id: next("atmcust"), device: next("atmdev") };
  const opened = daysAgo(openedDaysAgo, r.int(10, 20));
  kairos.track("account_opened", { userId: c.id, entities: { device: c.device }, timestamp: opened });
  kairos.track("kyc_completed", { userId: c.id, timestamp: new Date(opened.getTime() + 8 * MIN) });
  kairos.track("login", {
    userId: c.id,
    entities: { device: c.device },
    timestamp: new Date(opened.getTime() + 9 * MIN),
  });
  return c;
}

/** The transfer in, and (for past ring members) the cash out that followed. */
function cashOut(c: Customer, atm: string, minutesAgo: number, withdrawn: boolean) {
  const usd = r.int(18, 29) * 100;
  kairos.track("transfer_in", {
    userId: c.id,
    entities: { sender: next("atmsender") },
    usd,
    memo: r.pick(["", "payment", "thanks", "for you"]),
    timestamp: ago((minutesAgo + r.int(12, 40)) * MIN),
  });
  kairos.track("login", { userId: c.id, entities: { device: c.device }, timestamp: ago((minutesAgo + 6) * MIN) });
  if (withdrawn)
    kairos.track("atm_withdrawal", {
      userId: c.id,
      entities: { atm },
      usd: CARD_LIMIT,
      timestamp: ago(minutesAgo * MIN),
    });
}

for (let i = 0; i < 80; i++) established(FLAGGED_ATM);
for (let i = 0; i < 40; i++) established(UNFLAGGED_ATM);
for (let i = 0; i < 20; i++) established(QUIET_ATM);

// Earlier members of the ring at the central ATM: last night and the night before.
const confirmed: string[] = [];
for (let i = 0; i < 5; i++) {
  const c = mule(r.int(5, 9));
  cashOut(c, FLAGGED_ATM, (i < 3 ? 2 : 1) * 24 * 60 + r.int(0, 40), true);
  if (i < 4) confirmed.push(c.id);
}

type Kind =
  | "mule_flagged_atm"
  | "mule_unflagged_atm"
  | "honest_regular"
  | "honest_new_account"
  | "honest_large_cash"
  | "honest_quiet_atm";
interface Pending {
  kind: Kind;
  customer: Customer;
  atm: string;
  usd: number;
}
const pending: Pending[] = [];

for (let i = 0; i < 6; i++) {
  const c = mule(r.int(4, 8));
  cashOut(c, FLAGGED_ATM, 0, false);
  pending.push({ kind: "mule_flagged_atm", customer: c, atm: FLAGGED_ATM, usd: CARD_LIMIT });
}
for (let i = 0; i < 6; i++) {
  const c = mule(r.int(4, 8));
  cashOut(c, UNFLAGGED_ATM, 0, false);
  pending.push({ kind: "mule_unflagged_atm", customer: c, atm: UNFLAGGED_ATM, usd: CARD_LIMIT });
}
for (let i = 0; i < 6; i++)
  pending.push({
    kind: "honest_regular",
    customer: established(FLAGGED_ATM),
    atm: FLAGGED_ATM,
    usd: r.pick([60, 80, 100, 200]),
  });
for (let i = 0; i < 3; i++) {
  // A new customer: opened two or three weeks ago, one payroll deposit, ordinary card spend.
  const c = { id: next("atmcust"), device: next("atmdev") };
  const age = r.int(12, 20);
  kairos.track("account_opened", { userId: c.id, entities: { device: c.device }, timestamp: daysAgo(age) });
  kairos.track("kyc_completed", { userId: c.id, timestamp: daysAgo(age, 22) });
  kairos.track("ach_deposit", { userId: c.id, usd: r.pick([1900, 2600]), source: "payroll", timestamp: daysAgo(3, 6) });
  for (let d = age - 1; d > 0; d--)
    if (r.chance(0.5))
      kairos.track("card_payment", {
        userId: c.id,
        entities: { merchant: r.pick(SHOPS) },
        usd: r.int(6, 70),
        timestamp: daysAgo(d),
      });
  pending.push({ kind: "honest_new_account", customer: c, atm: FLAGGED_ATM, usd: r.pick([100, 160, 200]) });
}
for (let i = 0; i < 3; i++) {
  const c = established(FLAGGED_ATM);
  kairos.track("support_message", {
    userId: c.id,
    text: "I am buying a used car from a private seller this weekend and he wants cash. What is my daily ATM limit?",
    timestamp: daysAgo(2, 12),
  });
  kairos.track("transfer_in", { userId: c.id, usd: 2500, source: "own savings account", timestamp: daysAgo(1, 9) });
  pending.push({ kind: "honest_large_cash", customer: c, atm: FLAGGED_ATM, usd: CARD_LIMIT });
}
for (let i = 0; i < 4; i++)
  pending.push({
    kind: "honest_quiet_atm",
    customer: established(QUIET_ATM),
    atm: QUIET_ATM,
    usd: r.pick([60, 100, 200]),
  });

// The mules at each ATM arrive within half an hour; honest customers are mixed in between.
const queue: Pending[] = [];
const mules = pending.filter((p) => p.kind.startsWith("mule"));
const honest = pending.filter((p) => !p.kind.startsWith("mule"));
while (mules.length || honest.length) {
  if (mules.length) queue.push(mules.shift()!);
  if (honest.length) queue.push(honest.shift()!);
}

const definition = template("atm_withdrawal");
// Optional: say what each entity type is. A kind classifies the type; it does not change a decision.
if (process.env.ATM_NO_KINDS !== "1") {
  await kairos.defineEntity("user", { kind: "person" });
  await kairos.defineEntity("atm", { kind: "place", description: "A cash machine" });
  await kairos.defineEntity("device", { kind: "device" });
  await kairos.defineEntity("merchant", { kind: "business" });
  await kairos.defineEntity("sender", { kind: "account", description: "The account a transfer came from" });
}
await kairos.defineAction("atm_withdrawal", definition);
await kairos.defineAction("atm_withdrawal_device_links_only", { ...definition, context: { linkTypes: ["device"] } });

await kairos.flush();
for (const id of confirmed) await kairos.label({ type: "user", id }, "mule_confirmed");
console.log(
  `${serial} entities, ${confirmed.length} confirmed mules at ${FLAGGED_ATM}, none at ${UNFLAGGED_ATM}, ${queue.length} withdrawals to decide\n`,
);

const results: { p: Pending; order: number; all: Decision; deviceOnly: Decision }[] = [];
const seenAt: Record<string, number> = {};
for (const p of queue) {
  // The request is itself an event: later withdrawals at the same ATM can see it.
  kairos.track("atm_withdrawal_requested", {
    userId: p.customer.id,
    entities: { atm: p.atm, device: p.customer.device },
    usd: p.usd,
  });
  const input = {
    userId: p.customer.id,
    entities: { atm: p.atm, device: p.customer.device },
    usd: p.usd,
    daily_limit_usd: CARD_LIMIT,
  };
  const all = await kairos.decide({ type: "atm_withdrawal", ...input });
  const deviceOnly = await kairos.decide({ type: "atm_withdrawal_device_links_only", ...input });
  const key = `${p.kind}`;
  seenAt[key] = (seenAt[key] ?? 0) + 1;
  results.push({ p, order: seenAt[key], all, deviceOnly });
}
await kairos.shutdown();

const KINDS: Kind[] = [
  "mule_flagged_atm",
  "mule_unflagged_atm",
  "honest_regular",
  "honest_new_account",
  "honest_large_cash",
  "honest_quiet_atm",
];
const held = (d: Decision) => d.decision !== "approve";
const mean = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);
console.log("                         ATM is a link         ATM is not a link");
console.log("kind                 n   mean risk  held       mean risk  held");
for (const kind of KINDS) {
  const rows = results.filter((x) => x.p.kind === kind);
  console.log(
    `${kind.padEnd(19)} ${String(rows.length).padStart(2)}   ${String(mean(rows.map((x) => x.all.riskScore))).padStart(9)}  ${String(rows.filter((x) => held(x.all)).length).padStart(4)}       ` +
      `${String(mean(rows.map((x) => x.deviceOnly.riskScore))).padStart(9)}  ${String(rows.filter((x) => held(x.deviceOnly)).length).padStart(4)}`,
  );
}
const bad = results.filter((x) => x.p.kind.startsWith("mule"));
const good = results.filter((x) => !x.p.kind.startsWith("mule"));
console.log(
  `\nmules held:   ${bad.filter((x) => held(x.all)).length} of ${bad.length} with the ATM as a link, ${bad.filter((x) => held(x.deviceOnly)).length} of ${bad.length} without`,
);
console.log(
  `honest held:  ${good.filter((x) => held(x.all)).length} of ${good.length} with the ATM as a link, ${good.filter((x) => held(x.deviceOnly)).length} of ${good.length} without\n`,
);

console.log("In arrival order at each ATM (risk with the ATM as a link / without):");
for (const kind of KINDS) {
  for (const { p, order: n, all, deviceOnly } of results.filter((x) => x.p.kind === kind)) {
    const atmReasons = all.reasons.filter((code) => code.startsWith("atm_"));
    console.log(
      `  ${kind.padEnd(19)} #${n}  ${p.customer.id}  ${String(all.riskScore).padStart(3)} / ${String(deviceOnly.riskScore).padStart(3)}  ${all.decision.padEnd(7)} ${atmReasons.join(", ")}`,
    );
  }
}

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
