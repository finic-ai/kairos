/**
 * Fraud claims and red flags at a consumer bank, end to end against a local server.
 *
 *   pnpm api
 *   pnpm example:claims
 *
 * Two decisions about a customer:
 *
 *   fraud_claim   A customer says "I did not make these transactions". Pay it
 *                 automatically, or hold it because the customer probably made the
 *                 transactions (first-party fraud) or is abusing claims?
 *   red_flag      A rule or a model raised a suspected red flag. Confirm and escalate
 *                 it, or is this the customer's own activity?
 *
 * The record shapes follow the two tables these come from in a bank's warehouse: a
 * claim has a category, a status, an amount and a free-text description; a red flag
 * has a flag type, a category, a source, a fraud scheme and a status. In Kairos both
 * are events, and their outcomes are labels. A label goes on the thing the outcome is
 * about: a claim closed as ACCOUNT_ABUSE labels the customer `account_abuse`; a
 * confirmed card fraud labels the merchant `fraud_reported`, not the victim. Labels
 * are what make links meaningful ("this device is used by three customers with
 * account-abuse outcomes"), and only the device and the payee count as links here: a
 * popular merchant is shared by too many unrelated customers to mean anything.
 *
 * All customers, merchants and payees are invented. The scenarios and the actions
 * were written together, so the output shows that the path works for this domain; it
 * does not measure accuracy.
 */
import { Rng } from "../packages/eval/src/rng";
import { Kairos, type Decision } from "../packages/sdk/src/index.js";
import { template } from "../templates/index";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY ?? missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  flushAt: 500,
  maxQueueSize: 100_000,
  decideTimeoutMs: 30_000,
  onError: (error) => console.error("delivery failed:", error.message),
});

// Event ids are stable, so running the example twice does not store the events twice.
let sequence = 0;
const send = kairos.track.bind(kairos);
kairos.track = (type, properties = {}) => {
  // CLAIMS_NO_UNIVERSAL_ID=1 sends every stage as a separate event, to compare the two.
  const { universalId, ...rest } = properties;
  return send(type, {
    eventId: `claims_${++sequence}`,
    ...(process.env.CLAIMS_NO_UNIVERSAL_ID === "1" ? rest : properties),
  });
};

const r = new Rng(31337);
const DAY = 24 * 60;
/** A moment `days` ago, at a given hour of that day. */
const at = (days: number, hour = r.int(8, 21), minute = r.int(0, 59)) =>
  new Date(Math.floor((Date.now() - days * DAY * 60_000) / 86_400_000) * 86_400_000 + (hour * 60 + minute) * 60_000);
const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

const CITIES = ["Austin", "Denver", "Columbus", "Tampa", "Portland", "Raleigh", "Phoenix", "Nashville"];
const ABROAD: [country: string, city: string][] = [
  ["PT", "Lisbon"],
  ["MX", "Cancun"],
  ["JP", "Osaka"],
  ["IT", "Florence"],
];
const HOSTILE: [country: string, city: string][] = [
  ["RO", "Bucharest"],
  ["VN", "Hanoi"],
  ["NG", "Lagos"],
  ["BR", "Fortaleza"],
];
const MERCHANTS: [id: string, channel: "card_present" | "online", usd: number][] = [
  ["greenleaf_grocery", "card_present", 84],
  ["metro_fuel", "card_present", 46],
  ["corner_coffee", "card_present", 7],
  ["streambox", "online", 16],
  ["quickbite_delivery", "online", 31],
  ["pixel_games_store", "online", 25],
  ["parcelhub_market", "online", 58],
  ["northside_pharmacy", "card_present", 22],
  ["tunewave", "online", 11],
  ["harbor_hardware", "card_present", 63],
  ["citycab", "online", 19],
  ["fresh_table_kitchen", "card_present", 54],
];
const usdOf = (merchant: string) => MERCHANTS.find((m) => m[0] === merchant)?.[2] ?? 40;

let serial = 0;
const next = (prefix: string) => `${prefix}_${String(++serial).padStart(4, "0")}`;
const ip = () => `${r.int(24, 208)}.${r.int(1, 254)}.${r.int(1, 254)}.${r.int(2, 250)}`;

interface Customer {
  id: string;
  city: string;
  device: string;
  ip: string;
  merchants: string[];
  friend: string;
  pay: number;
  payday: number;
}

function customer(): Customer {
  const merchants = new Set<string>();
  while (merchants.size < 6) merchants.add(r.pick(MERCHANTS)[0]);
  return {
    id: next("cust"),
    city: r.pick(CITIES),
    device: next("dev"),
    ip: ip(),
    merchants: [...merchants],
    friend: next("payee"),
    pay: r.pick([1900, 2400, 3100, 3800]),
    payday: r.int(0, 13),
  };
}

const login = (c: Customer, when: Date, o: { device?: string; ip?: string; country?: string; city?: string } = {}) =>
  kairos.track("login", {
    userId: c.id,
    entities: { device: o.device ?? c.device, ip: o.ip ?? c.ip },
    ip_country: o.country ?? "US",
    ip_city: o.city ?? c.city,
    timestamp: when,
  });

function cardPayment(
  c: Customer,
  when: Date,
  merchant: string,
  usd: number,
  o: { channel?: string; city?: string } = {},
) {
  const channel = o.channel ?? MERCHANTS.find((m) => m[0] === merchant)?.[1] ?? "online";
  kairos.track("card_payment", {
    userId: c.id,
    entities: { merchant },
    usd,
    channel,
    ...(channel === "card_present" ? { city: o.city ?? c.city } : {}),
    timestamp: when,
  });
}

const p2p = (c: Customer, when: Date, payee: string, usd: number, o: { device?: string; memo?: string } = {}) =>
  kairos.track("p2p_sent", {
    userId: c.id,
    entities: { payee, device: o.device ?? c.device },
    usd,
    ...(o.memo ? { memo: o.memo } : {}),
    timestamp: when,
  });

/** Ordinary life from `fromDay` days ago up to `toDay` days ago. */
function routine(
  c: Customer,
  fromDay: number,
  toDay: number,
  o: { device?: string; city?: string; country?: string; ip?: string } = {},
) {
  for (let d = fromDay; d > toDay; d--) {
    if (r.chance(0.42)) login(c, at(d), o);
    for (let n = r.weighted([0, 1, 2], [4, 4, 2]); n > 0; n--) {
      const merchant = r.pick(c.merchants);
      cardPayment(
        c,
        at(d),
        merchant,
        Math.round(usdOf(merchant) * r.float(0.6, 1.5) * 100) / 100,
        o.city ? { city: o.city } : {},
      );
    }
    if (d % 14 === c.payday)
      kairos.track("ach_deposit", { userId: c.id, usd: c.pay, source: "payroll", timestamp: at(d, 6, 10) });
    if (r.chance(0.05)) p2p(c, at(d), c.friend, r.pick([20, 35, 50, 80]));
  }
}

interface Claim {
  category: "UNAUTHORIZED_CARD" | "ACCOUNT_TAKEOVER" | "SCAM";
  usd: number;
  description: string;
  /** Days between the first disputed transaction and the claim. */
  daysAfter: number;
  entities: Record<string, string>;
}

/** Record a claim that was filed and closed in the past, with its outcome as a label. */
async function pastClaim(
  c: Customer,
  days: number,
  claim: Claim,
  status: "CONFIRMED" | "ACCOUNT_ABUSE" | "DENIED",
  label?: string,
) {
  const id = next("claim");
  // A claim is one record with two stages: filed, then closed with an outcome.
  kairos.track("fraud_claim_filed", {
    userId: c.id,
    universalId: id,
    status: "PENDING",
    entities: { claim: id, ...claim.entities },
    category: claim.category,
    initial_amount_usd: claim.usd,
    description: claim.description,
    timestamp: at(days, 11),
  });
  kairos.track("fraud_claim_closed", {
    userId: c.id,
    universalId: id,
    status,
    entities: { claim: id },
    timestamp: at(Math.max(days - 6, 0.2), 15),
  });
  if (label) labels.push({ id: c.id, label });
}

const labels: { type?: string; id: string; label: string }[] = [];
const HISTORY = 110;

// Shared infrastructure of the bad cases.
const FRAUD_MERCHANTS = ["lumatech_outlet", "vexa_digital_goods"]; // sell on stolen card numbers
const MULE_PAYEE = next("payee"); // receives money from taken-over accounts
const SCAM_PAYEE = next("payee"); // the "safe account"
const RING_DEVICE = next("dev"); // one phone, several customers, many claims
const RING_PAYEE = next("payee");
for (const id of FRAUD_MERCHANTS) labels.push({ type: "merchant", id, label: "fraud_reported" });
labels.push(
  { type: "payee", id: MULE_PAYEE, label: "mule_account_reported" },
  { type: "payee", id: SCAM_PAYEE, label: "scam_reported" },
);

type ClaimKind =
  | "card_theft"
  | "account_takeover"
  | "genuine_unusual"
  | "scam_victim"
  | "first_party"
  | "serial_claimant"
  | "claims_ring";
const pendingClaims: { kind: ClaimKind; customer: Customer; claim: Claim }[] = [];

/** Stolen card numbers used online: small tests, then large purchases, at a merchant the customer never used. */
function cardTheft(c: Customer, day: number): Claim {
  const merchant = r.pick(FRAUD_MERCHANTS);
  const start = at(day, r.int(1, 4));
  const amounts = [1, 2.5, r.int(380, 520), r.int(600, 900)];
  amounts.forEach((usd, i) => cardPayment(c, minutesAfter(start, i * 4), merchant, usd, { channel: "online" }));
  return {
    category: "UNAUTHORIZED_CARD",
    usd: amounts[2]! + amounts[3]! + 3.5,
    daysAfter: 1,
    entities: { merchant },
    description:
      "I still have my card with me. I do not recognise these online purchases and I have never heard of this shop.",
  };
}

/** A new device and a password reset, then transfers to a payee the customer never paid. */
function takeover(c: Customer, day: number): Claim {
  const [country, city] = r.pick(HOSTILE);
  const device = next("dev");
  const start = at(day, 3, r.int(0, 30));
  kairos.track("password_reset", { userId: c.id, entities: { ip: ip() }, ip_country: country, timestamp: start });
  login(c, minutesAfter(start, 3), { device, ip: ip(), country, city });
  kairos.track("phone_number_changed", { userId: c.id, entities: { device }, timestamp: minutesAfter(start, 6) });
  const amounts = [r.int(700, 1000), r.int(1100, 1600)];
  amounts.forEach((usd, i) => p2p(c, minutesAfter(start, 9 + i * 3), MULE_PAYEE, usd, { device }));
  return {
    category: "ACCOUNT_TAKEOVER",
    usd: amounts[0]! + amounts[1]!,
    daysAfter: 1,
    entities: { payee: MULE_PAYEE },
    description:
      "Someone got into my account during the night and sent my money to a person I do not know. I got a text that my phone number was changed.",
  };
}

// Background customers: ordinary lives, plus the earlier victims and abusers that links point at.
const background: Customer[] = [];
for (let i = 0; i < 12; i++) {
  const c = customer();
  routine(c, HISTORY, 0);
  background.push(c);
}
for (let i = 0; i < 6; i++) {
  const c = customer();
  routine(c, HISTORY, 0);
  const day = r.int(8, 40);
  const claim = cardTheft(c, day + 1);
  await pastClaim(c, day, claim, "CONFIRMED", "fraud_victim");
}
for (let i = 0; i < 3; i++) {
  const c = customer();
  routine(c, HISTORY, 0);
  const day = r.int(8, 40);
  const claim = takeover(c, day + 1);
  await pastClaim(c, day, claim, "CONFIRMED", "fraud_victim");
}
for (let i = 0; i < 3; i++) {
  const c = customer();
  routine(c, HISTORY, 0);
  const day = r.int(6, 30);
  p2p(c, at(day + 1, 14), SCAM_PAYEE, r.int(1500, 4000), { memo: "safe account" });
  await pastClaim(
    c,
    day,
    {
      category: "SCAM",
      usd: 2500,
      daysAfter: 1,
      entities: { payee: SCAM_PAYEE },
      description: "A man on the phone said my account was hacked and I had to move the money.",
    },
    "DENIED",
    "scam_victim",
  );
}
const ring: Customer[] = [];
for (let i = 0; i < 4; i++) {
  const c = customer();
  routine(c, HISTORY, 0);
  for (let d = 60; d > 2; d -= r.int(3, 7)) login(c, at(d), { device: RING_DEVICE });
  p2p(c, at(r.int(30, 50), 20), RING_PAYEE, r.int(600, 1400), { device: RING_DEVICE });
  if (i < 3)
    await pastClaim(
      c,
      r.int(20, 45),
      {
        category: "ACCOUNT_TAKEOVER",
        usd: 1100,
        daysAfter: 2,
        entities: { payee: RING_PAYEE },
        description: "I did not send this transfer.",
      },
      "ACCOUNT_ABUSE",
      "account_abuse",
    );
  ring.push(c);
}

for (let i = 0; i < 6; i++) {
  const c = customer();
  routine(c, HISTORY, 2);
  const claim = cardTheft(c, 1);
  login(c, at(0.2));
  kairos.track("card_locked", { userId: c.id, timestamp: at(0.2) });
  pendingClaims.push({ kind: "card_theft", customer: c, claim });
}

for (let i = 0; i < 5; i++) {
  const c = customer();
  routine(c, HISTORY, 2);
  const claim = takeover(c, 1);
  login(c, at(0.2));
  pendingClaims.push({ kind: "account_takeover", customer: c, claim });
}

// Genuine claims that look like abuse at first sight.
for (let i = 0; i < 4; i++) {
  const c = customer();
  if (i % 2 === 0) {
    // A second claim: the first one, a year ago, was confirmed as real fraud.
    routine(c, HISTORY, 2);
    await pastClaim(
      c,
      r.int(250, 340),
      {
        category: "UNAUTHORIZED_CARD",
        usd: 310,
        daysAfter: 1,
        entities: { merchant: "vexa_digital_goods" },
        description: "I did not make this purchase.",
      },
      "CONFIRMED",
      "fraud_victim",
    );
    const claim = cardTheft(c, 1);
    pendingClaims.push({ kind: "genuine_unusual", customer: c, claim });
  } else {
    // A late claim: the customer was abroad for three weeks and saw the charges on return.
    const [country, city] = r.pick(ABROAD);
    routine(c, HISTORY, 30);
    kairos.track("support_message", {
      userId: c.id,
      text: `I am travelling to ${city} for three weeks from tomorrow. Please do not block my card while I am away.`,
      timestamp: at(30, 10),
    });
    const claim = cardTheft(c, 24);
    routine(c, 29, 4, { city, country, ip: ip() });
    routine(c, 4, 0);
    pendingClaims.push({
      kind: "genuine_unusual",
      customer: c,
      claim: {
        ...claim,
        daysAfter: 24,
        description: `I was in ${city} for three weeks and only saw these charges when I got home. I did not make them and I do not know this shop.`,
      },
    });
  }
}

for (let i = 0; i < 4; i++) {
  const c = customer();
  routine(c, HISTORY, 1);
  const start = at(0.5, 13);
  login(c, start);
  const usd = r.int(2400, 5200);
  p2p(c, minutesAfter(start, 14), SCAM_PAYEE, usd, { memo: "safe account" });
  pendingClaims.push({
    kind: "scam_victim",
    customer: c,
    claim: {
      category: "SCAM",
      usd,
      daysAfter: 0,
      entities: { payee: SCAM_PAYEE },
      description:
        "A caller said he was from the bank's fraud team and told me to move my money to a safe account. I sent it myself from my phone, and now I cannot reach him.",
    },
  });
}

/** Purchases at shops the customer uses all the time, from the usual phone, disputed weeks later. */
function ownPurchases(c: Customer, firstDay: number): Claim {
  const shops = ["pixel_games_store", "quickbite_delivery"];
  for (const shop of shops) if (!c.merchants.includes(shop)) c.merchants.push(shop);
  let usd = 0;
  for (let n = 0; n < r.int(4, 6); n++) {
    const amount = r.int(60, 190);
    // Spread over the days up to the claim, never after it.
    const when = at(Math.max(firstDay - n * Math.min(2, firstDay / 6), 0.3), r.int(19, 23));
    login(c, minutesAfter(when, -4));
    cardPayment(c, when, r.pick(shops), amount, { channel: "online" });
    usd += amount;
  }
  return {
    category: "UNAUTHORIZED_CARD",
    usd,
    daysAfter: firstDay,
    entities: { merchant: shops[0]! },
    description: "I did not authorise any of these charges. Someone must have my card details.",
  };
}

for (let i = 0; i < 6; i++) {
  const c = customer();
  c.merchants.push("pixel_games_store", "quickbite_delivery");
  const firstDay = r.int(24, 38);
  routine(c, HISTORY, firstDay);
  const claim = ownPurchases(c, firstDay);
  routine(c, firstDay - 12, 0);
  kairos.track("low_balance_alert", { userId: c.id, balance_usd: r.int(4, 60), timestamp: at(1, 9) });
  pendingClaims.push({ kind: "first_party", customer: c, claim });
}

for (let i = 0; i < 5; i++) {
  const c = customer();
  c.merchants.push("pixel_games_store", "quickbite_delivery");
  routine(c, HISTORY, 6);
  const old: Claim = {
    category: "UNAUTHORIZED_CARD",
    usd: r.int(200, 600),
    daysAfter: 5,
    entities: { merchant: "pixel_games_store" },
    description: "These charges are not mine.",
  };
  await pastClaim(c, 300, old, "DENIED");
  await pastClaim(c, 190, old, "ACCOUNT_ABUSE", "account_abuse");
  await pastClaim(c, 85, old, "ACCOUNT_ABUSE");
  const raised = at(80, 10);
  const flag = {
    flag_type: "UNUSUAL_ACTIVITY",
    category: "FRAUD",
    source: "MANUAL_REVIEW",
    fraud_scheme: "ACCOUNT_MANIPULATION",
  };
  const flagId = next("flag");
  kairos.track("red_flag_raised", {
    userId: c.id,
    universalId: flagId,
    ...flag,
    status: "SUSPECTED",
    timestamp: raised,
  });
  kairos.track("red_flag_confirmed", {
    userId: c.id,
    universalId: flagId,
    status: "CONFIRMED",
    timestamp: minutesAfter(raised, 3 * DAY),
  });
  labels.push({ id: c.id, label: "red_flag_confirmed" });
  const claim = ownPurchases(c, 5);
  pendingClaims.push({ kind: "serial_claimant", customer: c, claim: { ...claim, daysAfter: 5 } });
}

for (let i = 0; i < 4; i++) {
  const c = customer();
  routine(c, HISTORY, 0);
  for (let d = 40; d > 1; d -= r.int(2, 5)) login(c, at(d), { device: RING_DEVICE });
  const start = at(2, 21);
  login(c, start, { device: RING_DEVICE });
  const amounts = [r.int(700, 1000), r.int(900, 1500)];
  amounts.forEach((usd, n) => p2p(c, minutesAfter(start, 5 + n * 6), RING_PAYEE, usd, { device: RING_DEVICE }));
  pendingClaims.push({
    kind: "claims_ring",
    customer: c,
    claim: {
      category: "ACCOUNT_TAKEOVER",
      usd: amounts[0]! + amounts[1]!,
      daysAfter: 2,
      entities: { payee: RING_PAYEE, device: RING_DEVICE },
      description: "I did not send these transfers. My account must have been hacked.",
    },
  });
}

type FlagKind = "takeover" | "card_testing" | "travel" | "large_own_transfer";
interface Flag {
  flag_type: string;
  category: string;
  source: string;
  product: string;
}
const pendingFlags: { kind: FlagKind; customer: Customer; flag: Flag }[] = [];

for (let i = 0; i < 4; i++) {
  const c = customer();
  routine(c, HISTORY, 1);
  takeover(c, 0.4);
  pendingFlags.push({
    kind: "takeover",
    customer: c,
    flag: {
      flag_type: "GEOGRAPHIC_ANOMALY",
      category: "ACCOUNT_SECURITY",
      source: "BEHAVIORAL_ANALYTICS",
      product: "CHECKING",
    },
  });
}
for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY, 1);
  const start = at(0.3, 4);
  for (let n = 0; n < 8; n++)
    cardPayment(
      c,
      minutesAfter(start, n * 2),
      `${r.pick(["zentro", "kavi", "moxa", "plura", "ordix"])}_online_${r.int(10, 99)}`,
      r.pick([1, 1.5, 2, 4.99]),
      { channel: "online" },
    );
  pendingFlags.push({
    kind: "card_testing",
    customer: c,
    flag: { flag_type: "VELOCITY_CHECK", category: "FRAUD_TRANSACTION", source: "RULE_ENGINE", product: "CHECKING" },
  });
}
for (let i = 0; i < 3; i++) {
  const c = customer();
  const [country, city] = r.pick(ABROAD);
  routine(c, HISTORY, 6);
  kairos.track("support_message", {
    userId: c.id,
    text: `I am flying to ${city} on Friday for two weeks. Will my debit card work there?`,
    timestamp: at(8, 12),
  });
  routine(c, 5, 0, { city, country, ip: ip() });
  login(c, at(0.1), { country, city, ip: ip() });
  pendingFlags.push({
    kind: "travel",
    customer: c,
    flag: {
      flag_type: "GEOGRAPHIC_ANOMALY",
      category: "ACCOUNT_SECURITY",
      source: "BEHAVIORAL_ANALYTICS",
      product: "CHECKING",
    },
  });
}
for (let i = 0; i < 3; i++) {
  const c = customer();
  routine(c, HISTORY, 0);
  const usd = r.int(38, 72) * 1000;
  kairos.track("support_message", {
    userId: c.id,
    text: "We are closing on a house next week. What is the daily limit for a wire to the title company, and can it be raised?",
    timestamp: at(6, 15),
  });
  kairos.track("wire_limit_raised", {
    userId: c.id,
    new_limit_usd: 100000,
    approved_by: "support",
    timestamp: at(5, 11),
  });
  kairos.track("transfer_in", { userId: c.id, usd, source: "own savings account", timestamp: at(1, 9) });
  login(c, at(0.2, 10));
  kairos.track("wire_sent", {
    userId: c.id,
    entities: { payee: "summit_title_escrow", device: c.device },
    usd,
    memo: "closing funds",
    timestamp: at(0.2, 10, 20),
  });
  pendingFlags.push({
    kind: "large_own_transfer",
    customer: c,
    flag: {
      flag_type: "AMOUNT_THRESHOLD",
      category: "TRANSACTION",
      source: "TRANSACTION_MONITORING",
      product: "CHECKING",
    },
  });
}

const claimAction = await kairos.defineAction("fraud_claim", template("fraud_claim"));

const flagAction = await kairos.defineAction("red_flag", template("red_flag"));
console.log(`actions ${claimAction.name}@${claimAction.version}, ${flagAction.name}@${flagAction.version}`);

await kairos.flush();
for (const { type, id, label } of labels) await kairos.label({ type: type ?? "user", id }, label);
console.log(
  `${serial} entities created, ${labels.length} outcome labels, ${pendingClaims.length} pending claims, ${pendingFlags.length} pending red flags\n`,
);

const claimResults: { kind: ClaimKind; decision: Decision; id: string }[] = [];
for (const { kind, customer: c, claim } of pendingClaims) {
  const id = next("claim");
  kairos.track("fraud_claim_filed", {
    userId: c.id,
    universalId: id,
    entities: { claim: id, ...claim.entities },
    category: claim.category,
    initial_amount_usd: claim.usd,
    description: claim.description,
    status: "PENDING",
  });
  const decision = await kairos.decide({
    type: "fraud_claim",
    userId: c.id,
    entities: { claim: id, ...claim.entities },
    category: claim.category,
    initial_amount_usd: claim.usd,
    days_since_first_disputed_transaction: claim.daysAfter,
  });
  claimResults.push({ kind, decision, id: c.id });
}

const flagResults: { kind: FlagKind; decision: Decision; id: string }[] = [];
for (const { kind, customer: c, flag } of pendingFlags) {
  kairos.track("red_flag_raised", { userId: c.id, ...flag, status: "SUSPECTED" });
  const decision = await kairos.decide({ type: "red_flag", userId: c.id, ...flag });
  flagResults.push({ kind, decision, id: c.id });
}
await kairos.shutdown();

function report<K extends string>(
  title: string,
  kinds: K[],
  rows: { kind: K; decision: Decision; id: string }[],
  expected: Record<K, string>,
) {
  console.log(title);
  console.log("kind               n  mean risk  approve  review  block  typology right");
  for (const kind of kinds) {
    const k = rows.filter((x) => x.kind === kind);
    const count = (outcome: string) => k.filter((x) => x.decision.decision === outcome).length;
    const mean = Math.round(k.reduce((a, x) => a + x.decision.riskScore, 0) / k.length);
    const right = k.filter((x) => x.decision.typology === expected[kind]).length;
    console.log(
      `${kind.padEnd(18)} ${String(k.length).padStart(2)}  ${String(mean).padStart(9)}  ${String(count("approve")).padStart(7)}  ${String(count("review")).padStart(6)}  ${String(count("block")).padStart(5)}  ${String(right).padStart(14)}`,
    );
  }
  console.log();
  for (const kind of kinds) {
    for (const { decision, id } of rows.filter((x) => x.kind === kind)) {
      console.log(
        `  ${kind.padEnd(18)} ${id}  ${decision.decision.padEnd(7)} ${String(decision.riskScore).padStart(3)}  ${(decision.typology ?? "").padEnd(18)} ${decision.reasons.join(", ")}`,
      );
    }
  }
  console.log();
}

report(
  "FRAUD CLAIMS  (approve = pay automatically)",
  ["card_theft", "account_takeover", "genuine_unusual", "scam_victim", "first_party", "serial_claimant", "claims_ring"],
  claimResults,
  {
    card_theft: "third_party_fraud",
    account_takeover: "third_party_fraud",
    genuine_unusual: "third_party_fraud",
    scam_victim: "scam_victim",
    first_party: "first_party_fraud",
    serial_claimant: "claim_abuse",
    claims_ring: "claim_abuse",
  },
);
report(
  "RED FLAGS  (approve = clear the flag)",
  ["takeover", "card_testing", "travel", "large_own_transfer"],
  flagResults,
  {
    takeover: "account_takeover",
    card_testing: "card_compromise",
    travel: "legitimate",
    large_own_transfer: "legitimate",
  },
);

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
