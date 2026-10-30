/**
 * Authorised push payment (APP) scams, end to end against a local server.
 *
 *   pnpm api
 *   pnpm example:scams
 *
 * A bank decides whether to release a payment that its own customer makes, or hold it and
 * speak to the customer. In a scam the customer is real, on their own phone, and means to
 * send the money: the device, the password and the payee check do not show it. What shows
 * it is the story of the last weeks and the shape of the visit.
 *
 * Every visit to the app carries `$session`, and the app reports what a banking app can
 * see: a phone call that is active, a remote access app that is running, details that are
 * pasted after a switch to another app, how the customer answers a scam warning and how
 * long they stay on it, the payee name check, a raised limit, money moved in from savings.
 *
 * Thirteen kinds of payment are generated. Six are honest, seven are not:
 *
 *   clean                rent or a friend, an existing payee, the usual phone
 *   clean_new_payee      a plumber, added and checked, a short look at the warning
 *   clean_house_deposit  savings moved in and the limit raised for a house deposit to a
 *                        solicitor that many customers pay
 *   clean_crypto         two years of monthly buys at a large crypto exchange
 *   pig_butchering       six weeks of growing payments to a platform, a small "profit"
 *                        back, a new loan, then a "release fee" or the biggest payment;
 *                        details pasted, limit raised, "No" to the warning about online
 *                        contacts after a long minute on it
 *   romance_scam         months of payments abroad to a partner never met: a flight, a
 *                        hospital bill, customs, now a visa
 *   impersonation_scam   a call from "the bank" during the visit, sometimes a remote
 *                        access app, all savings moved to a new "safe account" whose name
 *                        does not match
 *   purchase_scam        a deposit for a car or a puppy from a marketplace, not seen in
 *                        person, to a personal account
 *   invoice_redirection  a house deposit to new bank details from an email that looks like
 *                        the solicitor's, and the name does not match
 *   account_takeover     a new device, a password reset and a new email, then a payment
 *                        to a new payee: not a scam, for the contrast
 *   takeover_via_aggregator  the same, but the thief links a new app through the data
 *                        aggregator and pulls the money out through it
 *   clean_aggregator     a budgeting app reads the account through a data aggregator every
 *                        few days, then the customer pays a new plumber from their phone
 *   clean_pay_by_bank    the customer funds a brokerage account by bank payment through
 *                        the aggregator, so the request comes from the aggregator itself
 *
 * A data aggregator such as Plaid signs in to the accounts of many customers from the same
 * servers, so it is one device that hundreds of customers share, earlier scam and takeover
 * victims among them. A shared device is usually a sign of fraud; this one is not. The example
 * sends it as its own entity type, `aggregator`, which is not a link type of the action.
 *
 * All customers, payees and messages are invented. The scenarios and the action were
 * written together, so the output shows that the path works for this domain; it does not
 * measure accuracy.
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
kairos.track = (type, properties = {}) => send(type, { eventId: `app_scams_${++sequence}`, ...properties });

const r = new Rng(7070);
const DAY = 24 * 60;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
/** About `days` ago, in the evening, when people use their banking app. */
const evening = (days: number) => ago(days * DAY + r.int(-120, 120));

let serial = 0;
// Ids carry "aps" so that they never meet the ids of another example in the same account.
const next = (prefix: string) => `${prefix}_aps${String(++serial).padStart(4, "0")}`;

type Kind =
  | "clean"
  | "clean_new_payee"
  | "clean_house_deposit"
  | "clean_crypto"
  | "clean_aggregator"
  | "clean_pay_by_bank"
  | "pig_butchering"
  | "romance_scam"
  | "impersonation_scam"
  | "purchase_scam"
  | "invoice_redirection"
  | "account_takeover"
  | "takeover_via_aggregator";
type PayeeKind = "person" | "bill" | "business" | "crypto_exchange" | "investment_platform" | "own_account";
/** Something done in a visit, in minutes from a moment in it: a negative minute is before it. */
type Step = [minute: number, type: string, properties?: Record<string, unknown>];

interface Customer {
  id: string;
  device: string;
  salary: number;
  landlord: string;
  rent: number;
  friend: string;
}

function customer(): Customer {
  return {
    id: next("usr"),
    device: next("dev"),
    salary: r.pick([2600, 3100, 3800, 4500]),
    landlord: next("payee"),
    rent: r.pick([900, 1100, 1350]),
    friend: next("payee"),
  };
}

/** Events that only a visit has: sign-ins, screens, warnings, calls. Each carries the session of its visit. */
function visit(userId: string, $session: string, when: Date, steps: Step[]) {
  for (const [minute, type, properties] of steps)
    kairos.track(type, { userId, ...properties, $session, timestamp: new Date(when.getTime() + minute * 60_000) });
}

/** A payment that went out, in the visit it was made in. */
function paid(
  c: Customer,
  $session: string,
  when: Date,
  payee: string,
  usd: number,
  payeeKind: PayeeKind,
  reference: string,
) {
  kairos.track("payment_sent", {
    userId: c.id,
    entities: { payee, device: c.device },
    usd,
    payee_kind: payeeKind,
    reference,
    $session,
    timestamp: when,
  });
}

/** Months of ordinary life: salary, a weekly look at the balance, rent, now and then a friend. */
function routine(c: Customer, fromDay: number, toDay = 1) {
  for (let d = fromDay; d > toDay; d--) {
    if (d % 30 === 3) kairos.track("salary_received", { userId: c.id, usd: c.salary, timestamp: ago(d * DAY + 600) });
    if (d % 7 !== 0 && d % 30 !== 5) continue;
    const $session = next("sess");
    const when = evening(d);
    visit(c.id, $session, when, [
      [-3, "login", { entities: { device: c.device } }],
      [-2, "balance_viewed"],
    ]);
    if (d % 30 === 5) paid(c, $session, when, c.landlord, c.rent, "person", "rent");
    else if (r.chance(0.3))
      paid(
        c,
        $session,
        when,
        c.friend,
        r.pick([20, 40, 60]),
        "person",
        r.pick(["dinner", "tickets", "birthday present"]),
      );
  }
}

/** A new payee, with the bank's name check on the account. */
function payeeAdded(
  c: Customer,
  $session: string,
  when: Date,
  payee: string,
  o: {
    typedName: string;
    check: "match" | "close match" | "no match" | "not available";
    kind: PayeeKind;
    country?: string;
  },
) {
  kairos.track("payee_added", {
    userId: c.id,
    entities: { payee },
    typed_name: o.typedName,
    name_check: o.check,
    payee_kind: o.kind,
    ...(o.country ? { country: o.country } : {}),
    $session,
    timestamp: when,
  });
}

const warning = (minute: number, question: string, answer: string, seconds: number): Step[] => [
  [minute, "scam_warning_shown", { question }],
  [minute + seconds / 60, "scam_warning_answered", { answer, seconds_on_screen: seconds }],
];

const labels: { type: string; id: string; label: string }[] = [];
const pending: {
  kind: Kind;
  c: Customer;
  payee: string;
  usd: number;
  payeeKind: PayeeKind;
  reference: string;
  purpose: string;
  steps: Step[];
  before?: (session: string, now: Date) => void;
  channel?: string;
}[] = [];
const HISTORY = 150;

const COINVAULT = next("payee"); // a large, regulated crypto exchange
const AUREX = next("payee"); // "Aurex Digital Assets Ltd": a fake investment platform
const SAFE_ACCOUNT_MULE = next("payee"); // receives "safe account" transfers
const SELLER_MULE = next("payee"); // the "seller" on a marketplace
const SOLICITOR = next("payee"); // Harper & Lowe Solicitors, client account
const BROKER = next("payee"); // a large brokerage that customers fund by bank payment
// A data aggregator such as Plaid signs in from the same servers for every customer who links an app through
// it. It is its own entity type, not a device, so that sharing it does not link those customers.
const AGGREGATOR = next("agg");
labels.push(
  { type: "payee", id: AUREX, label: "scam_reported" },
  { type: "payee", id: SAFE_ACCOUNT_MULE, label: "mule_account_reported" },
  { type: "payee", id: SELLER_MULE, label: "scam_reported" },
);

/** A linked app reads the account through the aggregator every few days. Each read is its own short visit. */
function aggregatorReads(c: Customer, app: string, fromDay: number, toDay = 1) {
  for (let d = fromDay; d > toDay; d -= 3) {
    visit(c.id, next("sess"), ago(d * DAY + r.int(0, 600)), [
      [0, "login", { entities: { aggregator: AGGREGATOR }, channel: "open_banking_api", user_agent: "Plaid/2.0", app }],
      [0.1, "transactions_read", { app }],
    ]);
  }
}

/** A bank payment that the aggregator starts for the customer, for example to fund a brokerage account. */
function payByBank(c: Customer, when: Date, payee: string, usd: number, payeeKind: PayeeKind, app: string) {
  const $session = next("sess");
  visit(c.id, $session, when, [
    [-1, "login", { entities: { aggregator: AGGREGATOR }, channel: "open_banking_api", user_agent: "Plaid/2.0", app }],
  ]);
  kairos.track("payment_sent", {
    userId: c.id,
    entities: { payee, aggregator: AGGREGATOR },
    usd,
    payee_kind: payeeKind,
    reference: `${app} deposit`,
    channel: "open_banking_api",
    $session,
    timestamp: when,
  });
}

// Background: ordinary customers; some buy crypto every month, some bought a house through the solicitor.
for (let i = 0; i < 12; i++) {
  const c = customer();
  routine(c, HISTORY);
  if (i < 6)
    for (let d = HISTORY - 20; d > 2; d -= 30)
      paid(c, next("sess"), evening(d), COINVAULT, r.pick([200, 300, 500]), "crypto_exchange", "buy bitcoin");
  if (i >= 8)
    paid(c, next("sess"), evening(r.int(20, 120)), SOLICITOR, r.int(25, 60) * 1000, "business", "house deposit");
  if (i % 3 !== 2) aggregatorReads(c, r.pick(["Budgetly", "Mintwise", "TaxPal"]), HISTORY - r.int(0, 60));
  if (i % 4 === 1)
    for (let d = HISTORY - 10; d > 2; d -= 30)
      payByBank(c, evening(d), BROKER, r.pick([100, 250, 500]), "investment_platform", "Stockfolio");
}

// Earlier victims: what makes the scam payees known.
for (const [payee, kind, label] of [
  [AUREX, "investment_platform", "scam_victim"],
  [AUREX, "investment_platform", "scam_victim"],
  [SAFE_ACCOUNT_MULE, "person", "scam_victim"],
  [SELLER_MULE, "person", "scam_victim"],
  [COINVAULT, "crypto_exchange", "scam_victim"],
] as const) {
  const c = customer();
  routine(c, HISTORY);
  aggregatorReads(c, "Budgetly", HISTORY - 30);
  paid(c, next("sess"), evening(r.int(10, 60)), payee, r.int(2, 9) * 1000, kind, "transfer");
  labels.push({ type: "user", id: c.id, label });
}

// Earlier takeovers that went out through the aggregator: the thief linked an app with the stolen password.
for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY);
  aggregatorReads(c, "Mintwise", HISTORY - 40, 40);
  const when = evening(r.int(15, 35));
  visit(c.id, next("sess"), when, [[-30, "password_reset", { entities: { device: next("dev") }, ip_country: "RO" }]]);
  payByBank(c, when, next("payee"), r.int(2, 5) * 1000, "person", "QuickWallet");
  labels.push({ type: "user", id: c.id, label: "account_takeover_confirmed" });
}

const signIn = (c: Customer, minute = -6): Step[] => [
  [minute, "login", { entities: { device: c.device } }],
  [minute + 1, "balance_viewed"],
];

for (let i = 0; i < 4; i++) {
  const c = customer();
  routine(c, HISTORY);
  const rent = i % 2 === 0;
  pending.push({
    kind: "clean",
    c,
    payee: rent ? c.landlord : c.friend,
    usd: rent ? c.rent : 45,
    payeeKind: "person",
    reference: rent ? "rent" : "concert tickets",
    purpose: rent ? "paying a bill" : "paying a friend or family",
    steps: [...signIn(c), [-2, "payee_selected"]],
  });
}

for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY);
  const plumber = next("payee");
  pending.push({
    kind: "clean_new_payee",
    c,
    payee: plumber,
    usd: r.int(240, 520),
    payeeKind: "business",
    reference: "invoice 1043",
    purpose: "paying for work or services",
    before: (s, now) =>
      payeeAdded(c, s, new Date(now.getTime() - 5 * 60_000), plumber, {
        typedName: "R. Okafor Plumbing",
        check: "match",
        kind: "business",
      }),
    steps: [
      ...signIn(c, -9),
      [-6, "payee_details_typed", { seconds: 48 }],
      ...warning(-4, "Is this payment for work or goods you have seen in person?", "Yes, for work done at my home", 7),
    ],
  });
}

for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY);
  kairos.track("support_message", {
    userId: c.id,
    text: "We are buying our first home and complete on Friday. Our solicitor is Harper & Lowe. How do I raise my limit for one large payment?",
    timestamp: ago(5 * DAY),
  });
  const usd = r.int(28, 55) * 1000;
  pending.push({
    kind: "clean_house_deposit",
    c,
    payee: SOLICITOR,
    usd,
    payeeKind: "business",
    reference: "completion funds, 14 Elm Rd",
    purpose: "buying a house",
    before: (s, now) => {
      kairos.track("savings_transfer", {
        userId: c.id,
        usd,
        direction: "savings to current",
        $session: s,
        timestamp: new Date(now.getTime() - 9 * 60_000),
      });
      kairos.track("limit_raised", {
        userId: c.id,
        from_usd: 10000,
        to_usd: 60000,
        $session: s,
        timestamp: new Date(now.getTime() - 7 * 60_000),
      });
      payeeAdded(c, s, new Date(now.getTime() - 5 * 60_000), SOLICITOR, {
        typedName: "Harper & Lowe Solicitors",
        check: "match",
        kind: "business",
      });
    },
    steps: [
      ...signIn(c, -12),
      [-5.5, "payee_details_typed", { seconds: 70 }],
      ...warning(-3, "Did you get these bank details by email or text?", "No, from the solicitor in person", 12),
    ],
  });
}

for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY);
  for (let d = 700; d > 3; d -= 30)
    paid(c, next("sess"), evening(d), COINVAULT, r.pick([300, 400, 500]), "crypto_exchange", "buy bitcoin");
  pending.push({
    kind: "clean_crypto",
    c,
    payee: COINVAULT,
    usd: 500,
    payeeKind: "crypto_exchange",
    reference: "buy bitcoin",
    purpose: "investing",
    steps: [...signIn(c), [-2, "payee_selected"]],
  });
}

for (let i = 0; i < 3; i++) {
  const c = customer();
  routine(c, HISTORY);
  // A budgeting app reads the account, the last time a few minutes before the customer opens the app.
  aggregatorReads(c, "Budgetly", i === 0 ? 4 : HISTORY - 20);
  const plumber = next("payee");
  pending.push({
    kind: "clean_aggregator",
    c,
    payee: plumber,
    usd: r.int(180, 450),
    payeeKind: "business",
    reference: "boiler repair",
    purpose: "paying for work or services",
    before: (s, now) => {
      visit(c.id, next("sess"), new Date(now.getTime() - 25 * 60_000), [
        [
          0,
          "login",
          {
            entities: { aggregator: AGGREGATOR },
            channel: "open_banking_api",
            user_agent: "Plaid/2.0",
            app: "Budgetly",
          },
        ],
        [0.1, "transactions_read", { app: "Budgetly" }],
      ]);
      payeeAdded(c, s, new Date(now.getTime() - 5 * 60_000), plumber, {
        typedName: "Hale Heating Ltd",
        check: "match",
        kind: "business",
      });
    },
    steps: [
      ...signIn(c, -9),
      [-6, "payee_details_typed", { seconds: 52 }],
      ...warning(-4, "Is this payment for work or goods you have seen in person?", "Yes, for work done at my home", 6),
    ],
  });
}

for (let i = 0; i < 3; i++) {
  const c = customer();
  routine(c, HISTORY);
  // Months of deposits to the brokerage through the aggregator; the newest customer linked it three weeks ago.
  const since = i === 2 ? 21 : HISTORY - 10;
  aggregatorReads(c, "Stockfolio", since);
  for (let d = since - 1; d > 2; d -= 14)
    payByBank(c, evening(d), BROKER, r.pick([200, 300, 500]), "investment_platform", "Stockfolio");
  pending.push({
    kind: "clean_pay_by_bank",
    c,
    payee: BROKER,
    usd: r.pick([300, 500, 750]),
    payeeKind: "investment_platform",
    reference: "Stockfolio deposit",
    purpose: "investing",
    channel: "open_banking_api",
    steps: [
      [
        -1,
        "login",
        {
          entities: { aggregator: AGGREGATOR },
          channel: "open_banking_api",
          user_agent: "Plaid/2.0",
          app: "Stockfolio",
        },
      ],
    ],
  });
}

for (let i = 0; i < 4; i++) {
  const c = customer();
  routine(c, HISTORY);
  // The platform: the real exchange for two of them, the fake one for the other two.
  const platform = i < 2 ? COINVAULT : AUREX;
  const kind: PayeeKind = i < 2 ? "crypto_exchange" : "investment_platform";
  const pasted = (s: string, when: Date) =>
    visit(c.id, s, when, [
      [-4, "login", { entities: { device: c.device } }],
      [-2, "app_backgrounded", { seconds: r.int(40, 120) }],
      [-1, "payee_details_pasted"],
    ]);
  {
    const s = next("sess");
    const when = evening(42);
    pasted(s, when);
    payeeAdded(c, s, when, platform, {
      typedName: i < 2 ? "Coinvault Exchange" : "Aurex Digital Assets Ltd",
      check: "match",
      kind,
    });
  }
  for (const [d, usd] of [
    [41, 250],
    [34, 500],
    [25, 2000],
    [16, 5000],
    [6, 9000],
  ] as const) {
    const s = next("sess");
    const when = evening(d);
    if (usd >= 2000)
      kairos.track("savings_transfer", {
        userId: c.id,
        usd,
        direction: "savings to current",
        $session: s,
        timestamp: new Date(when.getTime() - 5 * 60_000),
      });
    visit(c.id, s, when, [
      [-6, "login", { entities: { device: c.device } }],
      [-1, "app_backgrounded", { seconds: r.int(30, 90) }],
    ]);
    paid(c, s, when, platform, usd, kind, "investment");
  }
  kairos.track("payment_received", {
    userId: c.id,
    entities: { payee: platform },
    usd: 150,
    reference: "profit withdrawal",
    timestamp: evening(31),
  });
  kairos.track("loan_disbursed", {
    userId: c.id,
    usd: 15000,
    purpose_stated: "home improvement",
    timestamp: evening(8),
  });
  if (i % 2)
    kairos.track("support_message", {
      userId: c.id,
      text: "Why is my transfer to my investment account limited? My account manager says I must pay the fee today or I lose my profits.",
      timestamp: evening(1),
    });
  // The last step: a "release fee" to a new person, or the biggest payment yet.
  const fee = i % 2 === 1;
  const payee = fee ? next("payee") : platform;
  const usd = fee ? r.int(5, 8) * 1000 : 12000;
  pending.push({
    kind: "pig_butchering",
    c,
    payee,
    usd,
    payeeKind: fee ? "person" : kind,
    reference: fee ? "fee" : "investment",
    purpose: fee ? "paying a friend or family" : "investing",
    before: (s, now) => {
      kairos.track("savings_transfer", {
        userId: c.id,
        usd,
        direction: "savings to current",
        $session: s,
        timestamp: new Date(now.getTime() - 11 * 60_000),
      });
      kairos.track("limit_raised", {
        userId: c.id,
        from_usd: 10000,
        to_usd: 25000,
        $session: s,
        timestamp: new Date(now.getTime() - 9 * 60_000),
      });
      if (fee)
        payeeAdded(c, s, new Date(now.getTime() - 6 * 60_000), payee, {
          typedName: "Li Wei",
          check: "match",
          kind: "person",
        });
    },
    steps: [
      ...signIn(c, -14),
      [-8, "app_backgrounded", { seconds: r.int(60, 180) }],
      ...(fee ? ([[-6.5, "payee_details_pasted"]] as Step[]) : []),
      ...warning(
        -4,
        "Has someone you met online, on social media or on a dating app asked you to invest or to pay a fee?",
        "No",
        r.int(45, 95),
      ),
    ],
  });
}

for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY);
  const partner = next("payee");
  {
    const s = next("sess");
    const when = evening(120);
    visit(c.id, s, when, [
      [-5, "login", { entities: { device: c.device } }],
      [-2, "app_backgrounded", { seconds: 140 }],
      [-1, "payee_details_pasted"],
    ]);
    payeeAdded(c, s, when, partner, {
      typedName: "Daniel Moreau",
      check: "not available",
      kind: "person",
      country: "GH",
    });
  }
  for (const [d, usd, reference] of [
    [118, 300, "flight ticket"],
    [90, 600, "phone"],
    [61, 900, "hospital bill"],
    [33, 1500, "customs fee"],
  ] as const) {
    const s = next("sess");
    const when = evening(d);
    visit(c.id, s, when, [
      [-6, "login", { entities: { device: c.device } }],
      [-2, "app_backgrounded", { seconds: r.int(90, 240) }],
      // The first time the warning came up, the answer was honest.
      ...(d === 61
        ? warning(-1, "Have you met the person you are paying in person?", "Not yet, we met online", 30)
        : []),
    ]);
    paid(c, s, when, partner, usd, "person", reference);
  }
  pending.push({
    kind: "romance_scam",
    c,
    payee: partner,
    usd: 3500,
    payeeKind: "person",
    reference: "visa",
    purpose: "paying a friend or family",
    steps: [
      ...signIn(c, -16),
      [-12, "app_backgrounded", { seconds: r.int(200, 400) }],
      ...warning(-4, "Have you met the person you are paying in person?", "Yes", r.int(40, 70)),
    ],
  });
}

for (let i = 0; i < 3; i++) {
  const c = customer();
  routine(c, HISTORY);
  const savings = r.int(8, 22) * 1000;
  const safe = i === 2 ? SAFE_ACCOUNT_MULE : next("payee");
  pending.push({
    kind: "impersonation_scam",
    c,
    payee: safe,
    usd: savings,
    payeeKind: "person",
    reference: "safe account",
    purpose: "moving money to my own account",
    before: (s, now) => {
      kairos.track("savings_transfer", {
        userId: c.id,
        usd: savings,
        direction: "savings to current",
        $session: s,
        timestamp: new Date(now.getTime() - 9 * 60_000),
      });
      payeeAdded(c, s, new Date(now.getTime() - 6 * 60_000), safe, {
        typedName: `${c.id.slice(-4)} Secure Account`,
        check: "no match",
        kind: "person",
      });
    },
    steps: [
      [-15, "call_active", { direction: "incoming", number_withheld: true, minutes_so_far: 4 }],
      ...signIn(c, -13),
      [-12, "balance_viewed"],
      ...(i === 0 ? ([[-11, "remote_access_detected", { app: "AnyDesk" }]] as Step[]) : []),
      [-7, "payee_details_typed", { seconds: 25 }],
      [
        -5.5,
        "name_check_warning_shown",
        { text: "The name does not match the account. Continue only if you are sure." },
      ],
      [-5.3, "name_check_warning_accepted"],
      ...warning(-4, "Has anyone told you to move your money to keep it safe?", "No", r.int(35, 80)),
      [-1, "call_active", { direction: "incoming", number_withheld: true, minutes_so_far: 18 }],
    ],
  });
}

for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY);
  const seller = i === 0 ? SELLER_MULE : next("payee");
  const [item, usd] = i === 0 ? ["deposit for a 2016 Golf", 1200] : ["puppy deposit", 650];
  pending.push({
    kind: "purchase_scam",
    c,
    payee: seller,
    usd,
    payeeKind: "person",
    reference: item,
    purpose: "buying goods",
    before: (s, now) =>
      payeeAdded(c, s, new Date(now.getTime() - 5 * 60_000), seller, {
        typedName: i === 0 ? "Mark Bennett" : "Sarah Collins",
        check: "close match",
        kind: "person",
      }),
    steps: [
      ...signIn(c, -8),
      [-6, "app_backgrounded", { seconds: 50 }],
      [-5.5, "payee_details_pasted"],
      ...warning(
        -3,
        "Have you seen the item in person, or is it from a site that protects your payment?",
        "No, I saw it on a marketplace",
        20,
      ),
    ],
  });
}

for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY);
  kairos.track("support_message", {
    userId: c.id,
    text: "We are completing on our flat this week. Can you raise my limit for the deposit to our solicitor?",
    timestamp: ago(4 * DAY),
  });
  const fake = next("payee");
  const usd = r.int(30, 50) * 1000;
  pending.push({
    kind: "invoice_redirection",
    c,
    payee: fake,
    usd,
    payeeKind: "business",
    reference: "completion funds",
    purpose: "buying a house",
    before: (s, now) => {
      kairos.track("savings_transfer", {
        userId: c.id,
        usd,
        direction: "savings to current",
        $session: s,
        timestamp: new Date(now.getTime() - 10 * 60_000),
      });
      kairos.track("limit_raised", {
        userId: c.id,
        from_usd: 10000,
        to_usd: 60000,
        $session: s,
        timestamp: new Date(now.getTime() - 8 * 60_000),
      });
      payeeAdded(c, s, new Date(now.getTime() - 5 * 60_000), fake, {
        typedName: "Harper & Lowe Solicitors",
        check: "no match",
        kind: "business",
      });
    },
    steps: [
      ...signIn(c, -12),
      [-6, "app_backgrounded", { seconds: 35 }],
      [-5.5, "payee_details_pasted"],
      [
        -4.8,
        "name_check_warning_shown",
        { text: "The name does not match the account. The account is in the name HL Client Services Ltd." },
      ],
      [-4.6, "name_check_warning_accepted"],
      ...warning(-3, "Did you get these bank details by email or text?", "Yes, by email from my solicitor", 15),
    ],
  });
}

for (let i = 0; i < 2; i++) {
  const c = customer();
  routine(c, HISTORY);
  const device = next("dev");
  const payee = next("payee");
  pending.push({
    kind: "account_takeover",
    c,
    payee,
    usd: r.int(2, 6) * 1000,
    payeeKind: "person",
    reference: "loan",
    purpose: "paying a friend or family",
    before: (s, now) =>
      payeeAdded(c, s, new Date(now.getTime() - 2 * 60_000), payee, {
        typedName: "K Novak",
        check: "match",
        kind: "person",
      }),
    steps: [
      [-6, "password_reset", { entities: { device }, ip_country: "RO" }],
      [-5, "login", { entities: { device }, ip_country: "RO" }],
      [-4, "email_changed", { entities: { device } }],
      [-2.5, "payee_details_pasted"],
    ],
  });
}

{
  const c = customer();
  routine(c, HISTORY);
  aggregatorReads(c, "Budgetly", HISTORY - 50);
  const device = next("dev");
  const payee = next("payee");
  pending.push({
    kind: "takeover_via_aggregator",
    c,
    payee,
    usd: r.int(3, 6) * 1000,
    payeeKind: "person",
    reference: "QuickWallet deposit",
    purpose: "moving money to my own account",
    channel: "open_banking_api",
    before: (s, now) =>
      visit(c.id, next("sess"), new Date(now.getTime() - 40 * 60_000), [
        [0, "password_reset", { entities: { device }, ip_country: "RO" }],
        [1, "login", { entities: { device }, ip_country: "RO" }],
        [2, "email_changed", { entities: { device } }],
      ]),
    steps: [
      [
        -3,
        "login",
        {
          entities: { aggregator: AGGREGATOR },
          channel: "open_banking_api",
          user_agent: "Plaid/2.0",
          app: "QuickWallet",
        },
      ],
      [-2.9, "transactions_read", { app: "QuickWallet" }],
    ],
  });
}

const action = await kairos.defineAction("push_payment", template("push_payment"));
console.log(`action ${action.name}@${action.version}`);
await kairos.defineEntity("aggregator", {
  description: "A data aggregator, such as Plaid, that signs in for apps the customer linked",
  link: false,
});
await kairos.setObject("aggregator", AGGREGATOR, { name: "Plaid" });
await kairos.flush();
for (const { type, id, label } of labels) await kairos.label({ type, id }, label);
console.log(`${serial} entities created, ${labels.length} outcome labels, ${pending.length} pending payments\n`);

const results: { kind: Kind; decision: Decision; id: string; ms: number }[] = [];
for (const p of pending) {
  const now = new Date();
  const session = next("sess");
  p.before?.(session, now);
  visit(p.c.id, session, now, p.steps);
  const device =
    (
      p.steps.find(([, type, props]) => type === "login" && props?.entities)?.[2]?.entities as
        { device?: string } | undefined
    )?.device ?? p.c.device;
  await kairos.flush();
  const started = Date.now();
  // The request is the event: it is stored, and the action it starts decides.
  const decision = await kairos.trackAndDecide("payment_requested", {
    userId: p.c.id,
    entities: { payee: p.payee, ...(p.channel ? { aggregator: AGGREGATOR } : { device }) },
    usd: p.usd,
    payee_kind: p.payeeKind,
    reference: p.reference,
    purpose: p.purpose,
    ...(p.channel ? { channel: p.channel } : {}),
    $session: session,
    timestamp: now,
  });
  results.push({ kind: p.kind, decision, id: p.c.id, ms: Date.now() - started });
}
await kairos.shutdown();

const KINDS: Kind[] = [
  "clean",
  "clean_new_payee",
  "clean_house_deposit",
  "clean_crypto",
  "clean_aggregator",
  "clean_pay_by_bank",
  "pig_butchering",
  "romance_scam",
  "impersonation_scam",
  "purchase_scam",
  "invoice_redirection",
  "account_takeover",
  "takeover_via_aggregator",
];
const EXPECTED: Record<Kind, string> = {
  clean: "legit",
  clean_new_payee: "legit",
  clean_house_deposit: "legit",
  clean_crypto: "legit",
  clean_aggregator: "legit",
  clean_pay_by_bank: "legit",
  pig_butchering: "investment_scam",
  romance_scam: "romance_scam",
  impersonation_scam: "impersonation_scam",
  purchase_scam: "purchase_scam",
  invoice_redirection: "invoice_redirection",
  account_takeover: "account_takeover",
  takeover_via_aggregator: "account_takeover",
};
const honest = (kind: Kind) => EXPECTED[kind] === "legit";
console.log("PAYMENTS  (approve = release)");
console.log("kind                  n  mean risk  approve  review  block  typology right");
for (const kind of KINDS) {
  const rows = results.filter((x) => x.kind === kind);
  const count = (outcome: string) => rows.filter((x) => x.decision.decision === outcome).length;
  const right = rows.filter((x) => x.decision.typology === EXPECTED[kind]).length;
  const mean = Math.round(rows.reduce((a, x) => a + x.decision.riskScore, 0) / rows.length);
  console.log(
    `${kind.padEnd(20)} ${String(rows.length).padStart(2)}  ${String(mean).padStart(9)}  ${String(count("approve")).padStart(7)}  ${String(count("review")).padStart(6)}  ${String(count("block")).padStart(5)}  ${String(right).padStart(14)}`,
  );
}
const bad = results.filter((x) => !honest(x.kind));
const good = results.filter((x) => honest(x.kind));
const stopped = (x: (typeof results)[number]) => x.decision.decision !== "approve";
const times = results.map((x) => x.ms).sort((a, b) => a - b);
console.log(`\nscam and takeover payments held: ${bad.filter(stopped).length} of ${bad.length}`);
console.log(`honest payments held:            ${good.filter(stopped).length} of ${good.length}`);
console.log(`decide() median ${times[Math.floor(times.length / 2)]} ms, max ${times.at(-1)} ms\n`);

for (const kind of KINDS) {
  for (const { decision, id } of results.filter((x) => x.kind === kind)) {
    console.log(
      `${kind.padEnd(20)} ${id}  ${decision.decision.padEnd(7)} ${String(decision.riskScore).padStart(3)}  ${(decision.typology ?? "").padEnd(19)} ${[...decision.reasons, ...decision.rules.map((rule) => `rule:${rule}`)].join(", ")}`,
    );
  }
}

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
