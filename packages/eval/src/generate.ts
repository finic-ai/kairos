/**
 * Generates the synthetic evaluation cases and writes them to cases/v1.jsonl.
 *
 * The cases are data, and the suite reads the file. The generator is seeded, so it writes the
 * same file each time. Run this to make the file in a new clone, or to
 * add or change scenarios, and bump the file version when you do, because results from
 * different case files are not comparable.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KairosEvent, LinkedEntities, PendingAction } from "@kairos/core";
import { Rng } from "./rng";

export const KINDS = [
  "normal_easy",
  "normal_hard",
  "normal_pass_through",
  "normal_new_account",
  "ato_easy",
  "ato_hard",
  "scam_easy",
  "scam_hard",
  "ring_one_hop",
  "ring_two_hop",
] as const;
export type Kind = (typeof KINDS)[number];

export interface EvalCase {
  id: string;
  kind: Kind;
  /** 1 when the withdrawal should not be approved without an intervention. */
  label: 0 | 1;
  expected_typology: "legit" | "ato" | "scam" | "mule";
  account: { opened: string; [trait: string]: unknown };
  events: KairosEvent[];
  pending_action: PendingAction;
  linked_entities: LinkedEntities;
  /** Reason codes whose truth is known by construction. null means ambiguous, so not scored. */
  facts: Record<"new_device" | "new_destination" | "risky_device_links" | "risky_destination_links", boolean | null>;
  note?: string;
}

const PER_KIND = 10;
const HISTORY = 200;
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 14, 0);

const CITIES = [
  ["GB", "London"],
  ["GB", "Leeds"],
  ["PT", "Lisbon"],
  ["IE", "Dublin"],
  ["GH", "Accra"],
  ["IS", "Reykjavik"],
] as const;
const ABROAD = [
  ["US", "Miami"],
  ["DE", "Berlin"],
  ["VN", "Hanoi"],
  ["BR", "Recife"],
  ["RO", "Cluj"],
  ["NG", "Lagos"],
  ["TH", "Bangkok"],
  ["ES", "Malaga"],
] as const;
const BENIGN_MESSAGES = [
  "How do I download my tax report for last year?",
  "Why is my bank deposit still pending?",
  "Can I change the currency shown in the app?",
  "What are the fees for a card purchase?",
  "How do I set a price alert?",
];
const SECOND_CITY: Record<string, string> = { GB: "Manchester", PT: "Porto", IE: "Cork", GH: "Kumasi", IS: "Akureyri" };
const KNOWN = "more than 1 year ago";

const ts = (t: number) => new Date(t).toISOString().slice(0, 16);
const atHour = (t: number, hour: number, minute: number) => Math.floor(t / DAY) * DAY + hour * 60 * MIN + minute * MIN;

interface User {
  country: string;
  city: string;
  device: string;
  addr: string;
  dep: number;
  balance: number;
  hours: readonly [number, number];
}

function makeUser(r: Rng): User {
  const [country, city] = r.pick(CITIES);
  return {
    country,
    city,
    device: r.id("dev"),
    addr: r.id("addr"),
    dep: r.pick([100, 200, 300, 500, 1000]),
    balance: Math.round(r.float(3000, 60000) / 100) * 100,
    hours: r.pick([
      [7, 10],
      [12, 14],
      [18, 23],
    ] as const),
  };
}

function login(
  u: User,
  t: number,
  o: { device?: string; loc?: readonly [string, string]; ok?: boolean } = {},
): KairosEvent {
  const [country, city] = o.loc ?? [u.country, u.city];
  return {
    ts: ts(t),
    type: o.ok === false ? "login_failed" : "login",
    device: o.device ?? u.device,
    ip_country: country,
    ip_city: city,
  };
}

/** `n` routine events in sessions, all before `end`. */
function noise(r: Rng, u: User, n: number, end: number, spanDays = Math.max(14, n * 0.45)): KairosEvent[] {
  const starts: number[] = [];
  for (let i = 0; i < Math.floor(n / 3) + 2; i++) {
    starts.push(atHour(end - r.float(0, spanDays) * DAY, r.int(u.hours[0], u.hours[1]), r.int(0, 59)));
  }
  const events: KairosEvent[] = [];
  for (const start of starts) {
    let t = start;
    events.push(login(u, t));
    for (let i = r.int(1, 5); i > 0; i--) {
      t += r.int(1, 6) * MIN;
      const type = r.weighted(
        [
          "view_portfolio",
          "view_prices",
          "buy",
          "sell",
          "deposit_bank",
          "price_alert_set",
          "statement_download",
          "support_message",
          "withdrawal_crypto",
        ],
        [30, 30, 10, 4, 8, 4, 2, 2, 2],
      );
      const e: KairosEvent = { ts: ts(t), type };
      if (type === "buy" || type === "sell")
        Object.assign(e, { asset: r.pick(["BTC", "ETH", "SOL"]), usd: Math.round(u.dep * r.float(0.3, 1.2)) });
      else if (type === "deposit_bank") e.usd = Math.round(u.dep * r.float(0.8, 1.3));
      else if (type === "support_message") e.text = r.pick(BENIGN_MESSAGES);
      else if (type === "withdrawal_crypto")
        Object.assign(e, { asset: "BTC", usd: Math.round(u.dep * r.float(0.5, 2)), destination: u.addr });
      events.push(e);
    }
  }
  return events
    .filter((e) => e.ts < ts(end))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .slice(-n);
}

function pending(
  asset: string,
  usd: number,
  balance: number,
  destination: string,
  added: string,
  requestedAt = NOW,
): PendingAction {
  return {
    type: "withdrawal_crypto",
    asset,
    usd: Math.round(usd),
    pct_of_balance: Math.min(100, Math.round((100 * usd) / balance)),
    destination,
    destination_added: added,
    requested_at: ts(requestedAt),
  };
}

interface Scenario {
  signal: KairosEvent[];
  pending: PendingAction;
  /** Routine history ends here; the signal may start earlier than its last routine event. */
  noiseEnd: number;
  /** Routine sessions continue during a multi-day signal. */
  overlap?: boolean;
  deviceSwitch?: { from: string; device: string };
  history?: number;
  historySpanDays?: number;
  opened?: number;
  balanceBefore?: number;
  facts: EvalCase["facts"];
  note?: string;
}

const NO_FACTS: EvalCase["facts"] = {
  new_device: false,
  new_destination: false,
  risky_device_links: null,
  risky_destination_links: null,
};

/** `index` rotates the variants of a kind, so that each variant gets an equal share of the cases. */
function scenario(kind: Kind, r: Rng, u: User, index: number): Scenario {
  const t0 = NOW - 12 * MIN;
  const view = (t: number): KairosEvent => ({ ts: ts(t), type: "view_portfolio" });

  if (kind === "normal_easy") {
    return {
      signal: [login(u, t0), view(t0 + 2 * MIN)],
      pending: pending("BTC", u.balance * r.float(0.03, 0.12), u.balance, u.addr, KNOWN),
      noiseEnd: t0,
      facts: NO_FACTS,
    };
  }

  if (kind === "normal_hard") {
    const variant = (["self_custody", "travel", "new_phone", "big_deposit"] as const)[index % 4]!;
    if (variant === "self_custody") {
      const addr = r.id("addr");
      const d = NOW - r.int(8, 14) * DAY;
      return {
        signal: [
          login(u, d - 2 * DAY),
          {
            ts: ts(d - 2 * DAY + 3 * MIN),
            type: "support_message",
            text: "I bought a hardware wallet. What is the safest way to move my coins to it?",
          },
          login(u, d),
          { ts: ts(d + 4 * MIN), type: "withdrawal_address_added", address: addr, label: "my ledger" },
          { ts: ts(d + 9 * MIN), type: "withdrawal_crypto", asset: "BTC", usd: 25, destination: addr },
          login(u, t0),
          view(t0 + 3 * MIN),
        ],
        pending: pending("BTC", u.balance * r.float(0.6, 0.9), u.balance, addr, ts(d + 4 * MIN)),
        noiseEnd: d - 3 * DAY,
        overlap: true,
        facts: { ...NO_FACTS, new_destination: null },
        note: variant,
      };
    }
    if (variant === "travel") {
      const loc = r.pick(ABROAD);
      const d = NOW - r.int(5, 9) * DAY;
      return {
        signal: [
          login(u, d),
          {
            ts: ts(d + 2 * MIN),
            type: "support_message",
            text: `I am travelling to ${loc[1]} next week. Will my account work abroad?`,
          },
          login(u, t0, { loc }),
          view(t0 + 2 * MIN),
          { ts: ts(t0 + 5 * MIN), type: "sell", asset: "ETH", usd: u.dep * 2 },
        ],
        pending: pending("BTC", u.balance * r.float(0.05, 0.2), u.balance, u.addr, KNOWN),
        noiseEnd: d - DAY,
        overlap: true,
        facts: NO_FACTS,
        note: variant,
      };
    }
    if (variant === "new_phone") {
      const device = r.id("dev");
      const d = NOW - r.int(15, 22) * DAY;
      return {
        signal: [
          login(u, d, { device }),
          { ts: ts(d + 3 * MIN), type: "two_factor_reenrolled", method: "authenticator_app", device },
          login(u, t0, { device }),
          { ts: ts(t0 + 2 * MIN), type: "buy", asset: "BTC", usd: u.dep },
        ],
        pending: pending("BTC", u.balance * r.float(0.1, 0.25), u.balance, u.addr, KNOWN),
        noiseEnd: t0,
        deviceSwitch: { from: ts(d), device },
        facts: NO_FACTS,
        note: variant,
      };
    }
    const d = NOW - r.int(3, 6) * DAY;
    const big = u.dep * r.pick([15, 25, 40]);
    return {
      signal: [
        login(u, d),
        { ts: ts(d + 3 * MIN), type: "deposit_bank", usd: big },
        { ts: ts(d + 30 * MIN), type: "buy", asset: "BTC", usd: big },
        login(u, t0),
        view(t0 + 2 * MIN),
      ],
      pending: pending("BTC", u.dep * r.float(1, 3), u.balance + big, u.addr, KNOWN),
      noiseEnd: d - DAY,
      overlap: true,
      facts: NO_FACTS,
      note: variant,
    };
  }

  if (kind === "normal_pass_through") {
    // The honest customer who buys and moves coins to their own wallet at once.
    if (index % 2 === 0) {
      // Established habit: the same cycle every month, to a known address.
      const signal: KairosEvent[] = [];
      const amount = u.dep * r.pick([3, 5, 8]);
      for (let m = r.int(4, 6); m >= 1; m--) {
        const d = atHour(NOW - m * 30 * DAY + r.int(-2, 2) * DAY, r.int(u.hours[0], u.hours[1]), r.int(0, 50));
        signal.push(
          login(u, d),
          { ts: ts(d + 2 * MIN), type: "deposit_bank", usd: amount },
          { ts: ts(d + 20 * MIN), type: "buy", asset: "BTC", usd: amount },
          { ts: ts(d + 25 * MIN), type: "withdrawal_crypto", asset: "BTC", usd: amount, destination: u.addr },
        );
      }
      const d = NOW - DAY;
      signal.push(login(u, d), { ts: ts(d + 2 * MIN), type: "deposit_bank", usd: amount * 1.5 }, login(u, t0), {
        ts: ts(t0 + 3 * MIN),
        type: "buy",
        asset: "BTC",
        usd: amount * 1.5,
      });
      return {
        signal,
        pending: pending("BTC", amount * 1.5, u.balance + amount * 1.5, u.addr, KNOWN),
        noiseEnd: NOW - 2 * DAY,
        facts: NO_FACTS,
        note: "monthly_habit",
      };
    }
    // First move to self-custody: a large deposit, a new address, everything out.
    const addr = r.id("addr");
    const d = NOW - r.int(1, 3) * DAY;
    const big = u.dep * r.pick([10, 20, 30]);
    const signal: KairosEvent[] = [
      login(u, d),
      { ts: ts(d + 3 * MIN), type: "deposit_bank", usd: big },
      { ts: ts(d + 35 * MIN), type: "buy", asset: "BTC", usd: big },
    ];
    if (r.chance(0.33))
      signal.push({
        ts: ts(d + 40 * MIN),
        type: "support_message",
        text: "Is there a fee to withdraw Bitcoin to my own wallet?",
      });
    signal.push(login(u, t0), {
      ts: ts(t0 + 4 * MIN),
      type: "withdrawal_address_added",
      address: addr,
      label: "trezor",
    });
    const before = Math.round(u.balance * 0.15);
    return {
      signal,
      pending: pending("BTC", big, big + before, addr, ts(t0 + 4 * MIN)),
      noiseEnd: d - DAY,
      balanceBefore: before,
      facts: { ...NO_FACTS, new_destination: true },
      note: "first_self_custody",
    };
  }

  if (kind === "normal_new_account" || kind === "ring_one_hop" || kind === "ring_two_hop") {
    const ring = kind !== "normal_new_account";
    const opened = atHour(NOW - (ring ? r.int(3, 6) : r.int(4, 9)) * DAY, r.int(u.hours[0], u.hours[1]), r.int(0, 59));
    const addr = r.id("addr");
    const signal: KairosEvent[] = [
      { ts: ts(opened), type: "account_opened" },
      { ts: ts(opened + 9 * MIN), type: "kyc_completed" },
      login(u, opened + 10 * MIN),
    ];
    let total = 0;
    const deposits = ring ? r.int(2, 4) : r.int(1, 2);
    for (let i = 0; i < deposits; i++) {
      const d = opened + 30 * MIN + i * r.int(5, 14) * 60 * MIN;
      const usd = ring ? Math.round(r.float(2000, 9000) / 100) * 100 : Math.round(r.float(300, 3000) / 50) * 50;
      total += usd;
      if (i > 0) signal.push(login(u, d - 2 * MIN));
      signal.push(
        { ts: ts(d), type: "deposit_bank", usd },
        { ts: ts(d + r.int(20, 90) * MIN), type: "buy", asset: ring ? "USDT" : r.pick(["BTC", "ETH"]), usd },
      );
    }
    signal.push(login(u, t0), { ts: ts(t0 + 3 * MIN), type: "withdrawal_address_added", address: addr });
    return {
      signal,
      pending: pending(
        ring ? "USDT" : "BTC",
        total * (ring ? r.float(0.97, 1) : r.float(0.8, 1)),
        total,
        addr,
        ts(t0 + 3 * MIN),
      ),
      noiseEnd: NOW - 60 * MIN,
      history: ring ? 4 : 8,
      historySpanDays: (NOW - opened) / DAY - 0.2,
      opened,
      balanceBefore: 0,
      facts: { ...NO_FACTS, new_destination: true },
    };
  }

  if (kind === "ato_easy" || kind === "ato_hard") {
    const device = r.id("dev");
    const addr = r.id("addr");
    const t = atHour(NOW, 3, r.int(30, 42));
    const requested = t + r.int(14, 24) * MIN;
    let signal: KairosEvent[];
    if (kind === "ato_easy") {
      const loc = r.pick(ABROAD);
      signal = [
        { ts: ts(t), type: "password_reset_requested", ip_country: loc[0] },
        { ts: ts(t + 2 * MIN), type: "password_reset_completed", ip_country: loc[0] },
        login(u, t + 3 * MIN, { device, loc }),
        { ts: ts(t + 5 * MIN), type: r.pick(["two_factor_disabled", "two_factor_method_changed"]), device },
        { ts: ts(t + 6 * MIN), type: "notification_settings_changed", withdrawal_emails: "off" },
      ];
    } else {
      const other = CITIES.filter(([c, city]) => c === u.country && city !== u.city).map(([, city]) => city);
      const loc = [u.country, other.length ? r.pick(other) : SECOND_CITY[u.country]!] as const;
      signal = [];
      for (let i = r.pick([0, 0, 2, 4]); i > 0; i--)
        signal.push(login(u, t + (2 - i) * MIN, { device, loc, ok: false }));
      signal.push(login(u, t + 3 * MIN, { device, loc }), view(t + 4 * MIN));
    }
    signal.push(
      { ts: ts(t + 8 * MIN), type: "sell", asset: "ETH", usd: Math.round(u.balance * 0.4) },
      { ts: ts(t + 9 * MIN), type: "sell", asset: "SOL", usd: Math.round(u.balance * 0.2) },
      { ts: ts(t + 11 * MIN), type: "withdrawal_address_added", address: addr },
    );
    return {
      signal,
      pending: pending("USDT", u.balance * r.float(0.95, 1), u.balance, addr, ts(t + 11 * MIN), requested),
      noiseEnd: t - DAY,
      facts: { ...NO_FACTS, new_device: true, new_destination: true },
    };
  }

  // scam_easy and scam_hard: rising deposits, each sent on to one new address.
  const easy = kind === "scam_easy";
  const addr = r.id("addr");
  const d0 = NOW - r.int(9, 13) * DAY;
  const steps = r.int(3, 5);
  const signal: KairosEvent[] = [];
  let amount = 0;
  for (let i = 0; i < steps; i++) {
    const d = d0 + i * 2.3 * DAY + r.int(0, 200) * MIN;
    amount = Math.round((u.dep * r.pick([6, 10, 15]) * 1.6 ** i) / 100) * 100;
    signal.push(
      login(u, d),
      { ts: ts(d + 3 * MIN), type: "deposit_bank", usd: amount },
      { ts: ts(d + 40 * MIN), type: "buy", asset: "USDT", usd: amount },
    );
    if (i === 0) signal.push({ ts: ts(d + 44 * MIN), type: "withdrawal_address_added", address: addr });
    if (i === 1) {
      const text = easy
        ? "My account manager at the trading platform says I must send funds to their wallet to unlock my profit. How do I raise my withdrawal limit?"
        : r.pick([null, "I want to raise my withdrawal limit. I am moving funds to my own wallet."]);
      if (text) signal.push({ ts: ts(d + 46 * MIN), type: "support_message", text });
      signal.push({ ts: ts(d + 50 * MIN), type: "withdrawal_limit_increase_requested" });
    }
    if (i < steps - 1)
      signal.push({ ts: ts(d + 55 * MIN), type: "withdrawal_crypto", asset: "USDT", usd: amount, destination: addr });
  }
  signal.push(login(u, t0));
  return {
    signal,
    pending: pending("USDT", amount, amount + u.balance * 0.02, addr, ts(d0 + 44 * MIN)),
    noiseEnd: d0 - DAY,
    overlap: true,
    balanceBefore: Math.round(u.balance * 0.02),
    facts: { ...NO_FACTS, new_destination: true },
  };
}

function links(
  kind: Kind,
  r: Rng,
  device: string,
  pend: PendingAction,
): { block: LinkedEntities; facts: Partial<EvalCase["facts"]> } {
  const added = String(pend.destination_added);
  let dev = {
    other_accounts: 0,
    other_accounts_opened_last_30_days: 0,
    other_accounts_with_fraud_or_takeover_report: 0,
  };
  let dst = {
    first_seen_on_platform: added,
    other_senders_last_30_days: 0,
    other_senders_with_scam_or_fraud_report: 0,
  };
  const daysAgo = (min: number, max: number) => ts(NOW - r.int(min, max) * DAY).slice(0, 10);

  if (kind === "ato_easy" || kind === "ato_hard") {
    if (r.chance(0.6)) {
      const n = r.int(1, 8);
      dev = {
        other_accounts: n,
        other_accounts_opened_last_30_days: r.int(0, 1),
        other_accounts_with_fraud_or_takeover_report: r.int(0, Math.min(3, n)),
      };
    }
    if (r.chance(0.5))
      dst = {
        first_seen_on_platform: daysAgo(0, 10),
        other_senders_last_30_days: r.int(1, 6),
        other_senders_with_scam_or_fraud_report: r.int(0, 2),
      };
  } else if (kind === "ring_one_hop") {
    const n = r.int(4, 8);
    dev = {
      other_accounts: n,
      other_accounts_opened_last_30_days: r.int(n - 2, n),
      other_accounts_with_fraud_or_takeover_report: r.int(1, 3),
    };
    dst = {
      first_seen_on_platform: daysAgo(2, 20),
      other_senders_last_30_days: r.int(3, 9),
      other_senders_with_scam_or_fraud_report: r.int(0, 2),
    };
  } else if (kind === "ring_two_hop") {
    // The risky accounts are two steps away, so the one-hop summary looks clean.
    dev = { other_accounts: 1, other_accounts_opened_last_30_days: 1, other_accounts_with_fraud_or_takeover_report: 0 };
    dst = {
      first_seen_on_platform: daysAgo(2, 20),
      other_senders_last_30_days: r.int(1, 2),
      other_senders_with_scam_or_fraud_report: 0,
    };
  } else {
    if (r.chance(0.3)) dev.other_accounts = r.int(1, 2); // shared household device
    if (kind === "scam_easy" || kind === "scam_hard") {
      if (r.chance(0.7)) {
        dst = {
          first_seen_on_platform: daysAgo(5, 40),
          other_senders_last_30_days: r.int(2, 15),
          other_senders_with_scam_or_fraud_report: r.chance(0.5) ? 0 : r.int(1, 3),
        };
      }
    } else if (added === KNOWN && r.chance(0.3)) {
      // A popular shared destination, for example a deposit address at another exchange.
      dst = {
        first_seen_on_platform: daysAgo(700, 1500),
        other_senders_last_30_days: r.int(5, 60),
        other_senders_with_scam_or_fraud_report: r.chance(0.1) ? 1 : 0,
      };
    }
  }
  return {
    block: { [`device ${device}`]: dev, [`destination ${String(pend.destination)}`]: dst },
    facts: {
      risky_device_links: dev.other_accounts_with_fraud_or_takeover_report > 0,
      risky_destination_links: dst.other_senders_with_scam_or_fraud_report > 0,
    },
  };
}

const TYPOLOGY: Record<Kind, EvalCase["expected_typology"]> = {
  normal_easy: "legit",
  normal_hard: "legit",
  normal_pass_through: "legit",
  normal_new_account: "legit",
  ato_easy: "ato",
  ato_hard: "ato",
  scam_easy: "scam",
  scam_hard: "scam",
  ring_one_hop: "mule",
  ring_two_hop: "mule",
};

export function generateCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  KINDS.forEach((kind, k) => {
    for (let i = 0; i < PER_KIND; i++) {
      const r = new Rng(1000 * (k + 1) + i);
      const u = makeUser(r);
      const s = scenario(kind, r, u, i);
      let events = noise(r, u, s.history ?? HISTORY, s.noiseEnd, s.historySpanDays);
      if (s.opened !== undefined) events = events.filter((e) => e.ts > ts(s.opened! + 10 * MIN));
      if (s.overlap) events.push(...noise(r, u, 8, NOW - 20 * 60 * MIN).filter((e) => e.ts > ts(s.noiseEnd)));
      if (s.deviceSwitch)
        for (const e of events) if (e.type === "login" && e.ts > s.deviceSwitch.from) e.device = s.deviceSwitch.device;
      events = [...events, ...s.signal].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

      const device = String(events.filter((e) => e.type === "login").at(-1)!.device);
      const linked = links(kind, r, device, s.pending);
      cases.push({
        id: `${kind}-${String(i).padStart(2, "0")}`,
        kind,
        label: kind.startsWith("normal") ? 0 : 1,
        expected_typology: TYPOLOGY[kind],
        account: {
          opened: ts(s.opened ?? NOW - r.int(500, 1500) * DAY).slice(0, 10),
          kyc_country: u.country,
          home_city: u.city,
          balance_usd_before_recent_activity: s.balanceBefore ?? u.balance,
        },
        events,
        pending_action: s.pending,
        linked_entities: linked.block,
        facts: { ...s.facts, ...linked.facts },
        ...(s.note ? { note: s.note } : {}),
      });
    }
  });
  return cases;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases = generateCases();
  const path = fileURLToPath(new URL("../cases/v1.jsonl", import.meta.url));
  writeFileSync(path, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`Wrote ${cases.length} cases to ${path}`);
}
