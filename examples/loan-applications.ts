/**
 * Consumer loan applications, end to end against a local server.
 *
 *   pnpm api
 *   pnpm example:loans
 *
 * A lender decides whether a personal loan application can go on to underwriting, or
 * must be held for a fraud analyst. The subject is the applicant; the entities that link
 * applicants together are the device, the IP address, the phone, the home address, the
 * SSN and the bank account the money goes to. The SSN is sent as a token, never as the
 * number: a link needs the same value each time, not the value itself.
 *
 * The action decides fraud only. Whether the applicant can afford the loan is a credit
 * decision, with its own rules on adverse action and explanations, and it stays in the
 * lender's underwriting.
 *
 * Six kinds of application are generated. Three are honest (two of them deliberately
 * unusual), three are not:
 *
 *   clean               an established applicant with a long credit file
 *   clean_thin_file     honest, with a file that looks like a synthetic one at first
 *                       sight: a student with one card, a new immigrant whose SSN was
 *                       issued last year
 *   clean_household     honest, at the same address and on the same laptop as a
 *                       partner who borrowed before and repaid
 *   synthetic_identity  one operator, many identities: new SSNs with thin files built
 *                       on authorised-user tradelines, sharing phones, a mail-drop
 *                       address, devices and payout accounts with earlier identities
 *                       that defaulted on the first payment
 *   identity_theft      a real person's long credit file used from abroad, with new
 *                       contact details and a new payout account; for an existing
 *                       customer, a password reset and contact changes come first
 *   loan_stacking       the real applicant, at many lenders in the same two weeks,
 *                       with a stated income twice the verified one
 *
 * Every pending application is submitted in a visit, and every event of that visit carries
 * `$session`. The visit is where much of the difference shows. An honest applicant
 * browses, tries the calculator, reads the terms and corrects a typo. A synthetic
 * identity goes straight to the form, sometimes with an automation tool, and one visit
 * applies for two people. A stolen identity comes in a browser that claims to be
 * another, or after a password reset and new contact details in the same visit. A
 * stacker raises the income after seeing how much they can borrow.
 *
 * All people, addresses and accounts are invented. The scenarios and the action were
 * written together, so the output shows that the path works for this domain; it does
 * not measure accuracy.
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
kairos.track = (type, properties = {}) => send(type, { eventId: `loan_applications_${++sequence}`, ...properties });

const r = new Rng(20261020);
const DAY = 24 * 60;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const THIS_YEAR = new Date().getFullYear();

type Network = "residential" | "mobile" | "vpn" | "datacenter";
type Kind = "clean" | "clean_thin_file" | "clean_household" | "synthetic_identity" | "identity_theft" | "loan_stacking";
/** Something done in the visit, in minutes from the start of the form: a negative minute is before it. */
type Step = [minute: number, type: string, properties?: Record<string, unknown>];

interface Application {
  id: string;
  kind: Kind;
  name: string;
  birthYear: number;
  state: string;
  ssn: { token: string; issuedYear: number };
  phone: string;
  emailDomain: string;
  address: string;
  device: string;
  ip: { address: string; country: string; network: Network };
  bank: { id: string; ageDays: number; holderNameMatch: boolean };
  bureau: {
    fileAgeYears: number;
    tradelines: number;
    authorisedUserTradelines: number;
    inquiries30d: number;
    nameDobSsnMatch: boolean;
    phoneOnFile: boolean;
    emailOnFile: boolean;
    addressOnFile: boolean;
  };
  income: { stated: number; verified: number | null; employer: string };
  loan: { usd: number; termMonths: number; purpose: string };
  minutesToComplete: number;
  pastedFields: number;
  /** Minutes before now that the application started. */
  startedAgo: number;
  /** For a pending application: the visit it is submitted in, and what else was done there. */
  session?: string;
  visit?: Step[];
}

const STATES: [state: string, city: string][] = [
  ["TX", "Austin"],
  ["OH", "Columbus"],
  ["FL", "Tampa"],
  ["NC", "Raleigh"],
  ["AZ", "Phoenix"],
  ["GA", "Atlanta"],
  ["CO", "Denver"],
];
const FIRST = [
  "Maria",
  "James",
  "Aisha",
  "Daniel",
  "Priya",
  "Marcus",
  "Elena",
  "Kevin",
  "Sofia",
  "Andre",
  "Grace",
  "Tyler",
  "Nadia",
  "Brandon",
  "Leah",
  "Omar",
  "Chloe",
  "Victor",
];
const LAST = [
  "Alvarez",
  "Brooks",
  "Chen",
  "Dawson",
  "Ellis",
  "Fischer",
  "Grant",
  "Hughes",
  "Ibrahim",
  "Jensen",
  "Kowalski",
  "Lopez",
  "Morgan",
  "Nguyen",
  "Okafor",
  "Patel",
  "Reyes",
  "Sullivan",
];
const EMPLOYERS = [
  "Lakeside Health",
  "Summit Logistics",
  "Bright Path Schools",
  "Harbor Freight Lines",
  "Northwind Software",
  "City of Columbus",
  "Redwood Dental Group",
  "Metro Transit",
];
const PURPOSES = ["debt consolidation", "home improvement", "car repair", "medical bills", "moving costs"];
const ABROAD = ["NG", "RO", "VN", "BR", "UA"];

const ip = () => `${r.int(23, 212)}.${r.int(1, 254)}.${r.int(1, 254)}.${r.int(2, 250)}`;
const datacenterIp = () => `${r.pick(["104.238", "185.220", "45.33", "162.247"])}.${r.int(1, 254)}.${r.int(2, 250)}`;
let serial = 0;
// Ids carry "loan" so that they never meet the ids of another example in the same account.
const next = (prefix: string) => `${prefix}_loan${String(++serial).padStart(4, "0")}`;
const phone = () => `+1${r.int(201, 989)}${r.int(2000000, 9999999)}`;
const street = () =>
  `${r.int(100, 9900)} ${r.pick(["Oak", "Maple", "Cedar", "Elm", "Pine", "Lake", "Hill"])} ${r.pick(["St", "Ave", "Dr", "Ln"])}`;

/** An ordinary, honest application. Every other kind starts from this and changes a few things. */
function clean(kind: Kind, startedAgo: number): Application {
  const [state, city] = r.pick(STATES);
  const birthYear = THIS_YEAR - r.int(27, 61);
  const stated = r.pick([42000, 51000, 58000, 67000, 74000, 88000]);
  return {
    id: next("usr"),
    kind,
    name: `${r.pick(FIRST)} ${r.pick(LAST)}`,
    birthYear,
    state,
    ssn: { token: next("ssn_tok"), issuedYear: birthYear + r.int(0, 2) },
    phone: phone(),
    emailDomain: r.pick(["gmail.com", "outlook.com", "yahoo.com", "icloud.com"]),
    address: `${street()}, ${city} ${state}`,
    device: next("dev"),
    ip: { address: ip(), country: "US", network: r.pick(["residential", "residential", "mobile"] as Network[]) },
    bank: { id: next("ba"), ageDays: r.int(700, 5000), holderNameMatch: true },
    bureau: {
      fileAgeYears: Math.min(THIS_YEAR - birthYear - 18, r.int(7, 25)),
      tradelines: r.int(6, 19),
      authorisedUserTradelines: r.int(0, 1),
      inquiries30d: r.int(0, 2),
      nameDobSsnMatch: true,
      phoneOnFile: true,
      emailOnFile: true,
      addressOnFile: true,
    },
    income: { stated, verified: Math.round(stated * r.float(0.92, 1.03)), employer: r.pick(EMPLOYERS) },
    loan: {
      usd: r.pick([3000, 5000, 7500, 10000, 15000]),
      termMonths: r.pick([24, 36, 48, 60]),
      purpose: r.pick(PURPOSES),
    },
    minutesToComplete: r.int(9, 26),
    pastedFields: r.int(0, 2),
    startedAgo,
  };
}

/** Send the events of one application. `outcome` adds what happened after a past application was approved. */
function track(a: Application, outcome?: "repaid" | "first_payment_default") {
  const userId = a.id;
  const at = (offset: number) => ago(a.startedAgo - offset);
  const step = a.minutesToComplete / 7;
  const $session = a.session;
  const track = (type: string, properties: Record<string, unknown>) =>
    kairos.track(type, $session ? { ...properties, $session } : properties);
  for (const [minute, type, properties] of a.visit ?? []) track(type, { userId, ...properties, timestamp: at(minute) });
  track("application_started", {
    userId,
    entities: { device: a.device, ip: a.ip.address },
    ip_country: a.ip.country,
    network: a.ip.network,
    product: "personal_loan",
    timestamp: at(0),
  });
  track("identity_submitted", {
    userId,
    entities: { ssn: a.ssn.token },
    name: a.name,
    birth_year: a.birthYear,
    timestamp: at(step),
  });
  track("contact_submitted", {
    userId,
    entities: { phone: a.phone, address: a.address },
    email_domain: a.emailDomain,
    state: a.state,
    timestamp: at(step * 2),
  });
  track("bureau_report_received", {
    userId,
    file_age_years: a.bureau.fileAgeYears,
    tradelines: a.bureau.tradelines,
    authorised_user_tradelines: a.bureau.authorisedUserTradelines,
    inquiries_last_30_days: a.bureau.inquiries30d,
    name_dob_ssn_match: a.bureau.nameDobSsnMatch,
    ssn_issued_year: a.ssn.issuedYear,
    phone_on_file: a.bureau.phoneOnFile,
    email_on_file: a.bureau.emailOnFile,
    address_on_file: a.bureau.addressOnFile,
    timestamp: at(step * 3),
  });
  track("income_stated", {
    userId,
    stated_annual_income_usd: a.income.stated,
    employer: a.income.employer,
    ...(a.income.verified === null
      ? { verification: "not_done" }
      : { verification: "payroll_data", verified_annual_income_usd: a.income.verified }),
    timestamp: at(step * 4),
  });
  track("bank_account_linked", {
    userId,
    entities: { bank_account: a.bank.id },
    account_age_days: a.bank.ageDays,
    holder_name_matches_applicant: a.bank.holderNameMatch,
    timestamp: at(step * 5),
  });
  track("application_submitted", {
    userId,
    entities: { device: a.device, ip: a.ip.address },
    amount_usd: a.loan.usd,
    term_months: a.loan.termMonths,
    purpose: a.loan.purpose,
    minutes_to_complete: a.minutesToComplete,
    pasted_fields: a.pastedFields,
    timestamp: at(a.minutesToComplete),
  });
  if (!outcome) return;
  const loanId = next("loan");
  const disbursed = a.startedAgo - a.minutesToComplete - 2 * DAY;
  kairos.track("loan_disbursed", {
    userId,
    entities: { bank_account: a.bank.id },
    universalId: loanId,
    status: "active",
    usd: a.loan.usd,
    timestamp: ago(disbursed),
  });
  const installment = Math.round((a.loan.usd / a.loan.termMonths) * 1.08);
  for (let month = 1; month * 30 * DAY < disbursed; month++) {
    const due = ago(disbursed - month * 30 * DAY);
    if (outcome === "first_payment_default") {
      kairos.track("loan_payment", {
        userId,
        universalId: `${loanId}_${month}`,
        status: "missed",
        installment: month,
        usd: installment,
        timestamp: due,
      });
      if (month === 2)
        kairos.track("loan_disbursed", { userId, universalId: loanId, status: "charged_off", timestamp: due });
      if (month === 2) break;
    } else {
      kairos.track("loan_payment", {
        userId,
        universalId: `${loanId}_${month}`,
        status: "paid",
        installment: month,
        usd: installment,
        timestamp: due,
      });
    }
  }
}

/** An existing customer's ordinary life with the lender: logins and payroll deposits. */
function customerHistory(a: Application, days: number) {
  for (let d = days; d > 1; d--) {
    if (r.chance(0.3))
      kairos.track("login", {
        userId: a.id,
        entities: { device: a.device, ip: a.ip.address },
        ip_country: "US",
        timestamp: ago(d * DAY - r.int(0, DAY / 2)),
      });
    if (d % 14 === 0)
      kairos.track("deposit", {
        userId: a.id,
        usd: Math.round(a.income.stated / 26),
        source: "payroll",
        employer: a.income.employer,
        timestamp: ago(d * DAY - 6 * 60),
      });
  }
}

/** How an honest applicant arrives: from somewhere, a look at the rates, the calculator, the terms, a typo fixed. */
function browsing(a: Application, pages = ["rates and fees", "how we check your identity"]): Step[] {
  const step = a.minutesToComplete / 7;
  return [
    [
      -r.int(9, 16),
      "visit_started",
      {
        referrer: r.pick(["search", "email from the lender", "personal finance article"]),
        landing_page: "personal loans",
        browser: r.pick(["chrome", "safari", "edge"]),
        bot: false,
        browser_consistent: true,
      },
    ],
    [-7, "page_viewed", { page: pages[0] }],
    [-5.5, "loan_calculator_used", { amount_usd: Math.round(a.loan.usd * 1.5), term_months: a.loan.termMonths }],
    [-4.5, "loan_calculator_used", { amount_usd: a.loan.usd, term_months: a.loan.termMonths }],
    [-2, "page_viewed", { page: pages[1] }],
    [step * 2.4, "field_corrected", { field: r.pick(["street address", "employer name", "date of birth"]) }],
    [a.minutesToComplete - 1, "page_viewed", { page: "loan agreement" }],
  ];
}

/** Straight to the form: no landing page, no calculator. */
const direct = (o: Record<string, unknown> = {}): Step[] => [
  [
    -0.3,
    "visit_started",
    {
      referrer: "direct",
      landing_page: "application form",
      browser: "chrome",
      bot: false,
      browser_consistent: true,
      ...o,
    },
  ],
];

const past: { app: Application; outcome: "repaid" | "first_payment_default"; labels: string[] }[] = [];
const pending: Application[] = [];
const history = (a: Application, outcome: "repaid" | "first_payment_default", labels: string[] = []) =>
  past.push({ app: a, outcome, labels });
const apply = (a: Application) =>
  pending.push({ ...a, session: a.session ?? next("sess"), visit: a.visit ?? browsing(a) });
const longAgo = () => r.int(150, 400) * DAY;
const recent = () => r.int(20, 600);

// Background: earlier borrowers who repaid, so that links have something ordinary to point at.
for (let i = 0; i < 8; i++) history(clean("clean", longAgo()), "repaid");

for (let i = 0; i < 8; i++) apply(clean("clean", recent()));

// clean_thin_file: honest applicants whose files look new.
for (let i = 0; i < 2; i++) {
  // A student with one card of their own and a part-time job.
  const a = clean("clean_thin_file", recent());
  const birthYear = THIS_YEAR - r.int(19, 22);
  const student: Application = {
    ...a,
    birthYear,
    ssn: { ...a.ssn, issuedYear: birthYear },
    bureau: { ...a.bureau, fileAgeYears: 1, tradelines: 1, authorisedUserTradelines: 0, inquiries30d: 1 },
    income: { stated: 18000, verified: 17400, employer: "Campus Bookstore" },
    loan: { usd: 2000, termMonths: 24, purpose: "laptop for school" },
  };
  apply({ ...student, visit: browsing(student, ["who can apply", "building your credit history"]) });
}
{
  // A new immigrant on a work visa: SSN issued last year, a new US phone, a verified salary.
  const a = clean("clean_thin_file", recent());
  const newcomer: Application = {
    ...a,
    ssn: { ...a.ssn, issuedYear: THIS_YEAR - 1 },
    bureau: {
      ...a.bureau,
      fileAgeYears: 1,
      tradelines: 2,
      authorisedUserTradelines: 0,
      phoneOnFile: false,
      inquiries30d: 1,
    },
    bank: { ...a.bank, ageDays: r.int(200, 330) },
    income: { stated: 96000, verified: 96000, employer: "Northwind Software" },
    loan: { usd: 6000, termMonths: 36, purpose: "furniture for a new apartment" },
  };
  apply({
    ...newcomer,
    visit: [
      ...browsing(newcomer, ["who can apply", "applying with a new credit history"]),
      [
        -3.5,
        "help_chat_message",
        { text: "I moved to the US last year for work, so my SSN and my credit history are new. Can I still apply?" },
      ],
      [
        -3,
        "help_chat_reply",
        { text: "Yes. We check your income with your employer's payroll data instead of a long credit history." },
      ],
    ],
  });
}

// clean_household: a partner who borrowed before and repaid; same address, same laptop.
for (let i = 0; i < 2; i++) {
  const first = clean("clean", longAgo());
  history(first, "repaid");
  const a = clean("clean_household", recent());
  apply({
    ...a,
    name: `${a.name.split(" ")[0]} ${first.name.split(" ")[1]}`,
    address: first.address,
    device: first.device,
    ip: first.ip,
    state: first.state,
  });
}

// synthetic_identity: three earlier identities defaulted on the first payment; five more arrive.
{
  const phones = [phone(), phone()];
  const devices = [next("dev"), next("dev")];
  const banks = [next("ba"), next("ba")];
  const mailDrop = "2201 Commerce Pkwy Ste 114, Houston TX";
  const synthetic = (startedAgo: number, i: number): Application => {
    const a = clean("synthetic_identity", startedAgo);
    const birthYear = THIS_YEAR - r.int(29, 41);
    return {
      ...a,
      birthYear,
      state: "TX",
      ssn: { token: next("ssn_tok"), issuedYear: THIS_YEAR - r.int(3, 6) },
      phone: phones[i % 2]!,
      address: i % 3 === 2 ? `${street()}, Houston TX` : mailDrop,
      device: devices[i % 2]!,
      ip: { address: i % 2 ? datacenterIp() : ip(), country: "US", network: i % 2 ? "datacenter" : "mobile" },
      bank: { id: banks[(i + 1) % 2]!, ageDays: r.int(20, 90), holderNameMatch: i % 2 === 0 },
      bureau: {
        fileAgeYears: r.int(1, 2),
        tradelines: r.int(3, 5),
        authorisedUserTradelines: r.int(2, 4),
        inquiries30d: r.int(1, 3),
        nameDobSsnMatch: true,
        phoneOnFile: true,
        emailOnFile: false,
        addressOnFile: true,
      },
      income: {
        stated: r.pick([72000, 85000, 94000]),
        verified: null,
        employer: r.pick(["Self-employed consulting", "Lone Star Holdings LLC"]),
      },
      loan: { usd: r.pick([15000, 20000, 25000]), termMonths: 60, purpose: "debt consolidation" },
      minutesToComplete: r.int(3, 6),
      pastedFields: r.int(8, 12),
    };
  };
  [0, 1, 2].forEach((i) =>
    history(synthetic(r.int(70, 140) * DAY, i), "first_payment_default", [
      "first_payment_default",
      "synthetic_identity_confirmed",
    ]),
  );
  // The last two come from one visit: the operator applies for one identity, then the next.
  const shared = next("sess");
  [210, 160, 95, 24, 12].forEach((startedAgo, i) => {
    const a = synthetic(startedAgo, i + 3);
    const bot = i % 2 === 1;
    apply({
      ...a,
      ...(i >= 3 ? { session: shared } : {}),
      visit: [
        ...direct(bot ? { bot: true, bot_kind: "headless_chrome" } : {}),
        [a.minutesToComplete * 0.3, "field_pasted", { fields: ["name", "SSN", "date of birth", "address", "phone"] }],
      ],
    });
  });
}

// identity_theft: two new to the lender, two existing customers whose accounts were taken over first.
for (let i = 0; i < 4; i++) {
  const a = clean("identity_theft", recent());
  const country = r.pick(ABROAD);
  const stolen: Application = {
    ...a,
    birthYear: THIS_YEAR - r.int(48, 66),
    phone: phone(),
    emailDomain: r.pick(["proton.me", "tutanota.com", "gmail.com"]),
    device: next("dev"),
    ip: {
      address: i % 2 ? datacenterIp() : ip(),
      country: i % 2 ? "US" : country,
      network: i % 2 ? "datacenter" : "vpn",
    },
    bank: { id: next("ba"), ageDays: r.int(2, 14), holderNameMatch: false },
    bureau: {
      ...a.bureau,
      fileAgeYears: r.int(18, 30),
      tradelines: r.int(14, 24),
      phoneOnFile: false,
      emailOnFile: false,
    },
    income: { ...a.income, verified: null },
    loan: { usd: r.pick([20000, 25000, 35000]), termMonths: 60, purpose: "home improvement" },
    minutesToComplete: r.int(3, 6),
    pastedFields: r.int(9, 13),
  };
  if (i < 2) {
    // An existing customer: months of ordinary history, then a takeover in the same visit as the application.
    const own = { ...a, ip: { address: ip(), country: "US", network: "residential" as Network } };
    customerHistory(own, 200);
    const where = { entities: { device: stolen.device, ip: stolen.ip.address }, ip_country: stolen.ip.country };
    apply({
      ...stolen,
      visit: [
        [
          -15,
          "visit_started",
          { referrer: "direct", landing_page: "sign in", browser: "chrome", bot: false, browser_consistent: true },
        ],
        [-14, "password_reset", where],
        [-12, "login", where],
        [-9, "phone_number_changed", where],
        [-7, "email_changed", { ...where, new_email_domain: stolen.emailDomain }],
        [-2, "page_viewed", { page: "personal loans" }],
      ],
    });
  } else {
    // New to the lender: a browser that claims to be Safari on an iPhone but runs Chromium.
    apply({
      ...stolen,
      visit: [
        ...direct({ browser: "chrome", claimed_browser: "safari on ios", browser_consistent: false }),
        [stolen.minutesToComplete - 0.5, "page_viewed", { page: "when will I get the money" }],
      ],
    });
  }
}

// loan_stacking: the real person, at many lenders at once, with an inflated income.
for (let i = 0; i < 4; i++) {
  const a = clean("loan_stacking", recent());
  const stacker: Application = {
    ...a,
    bank: { ...a.bank, ageDays: i % 2 ? r.int(5, 20) : a.bank.ageDays },
    bureau: { ...a.bureau, inquiries30d: r.int(7, 12) },
    income: { ...a.income, stated: a.income.stated * 2, verified: a.income.stated },
    loan: { usd: r.pick([25000, 30000, 40000]), termMonths: 60, purpose: "debt consolidation" },
  };
  // From a comparison site, told the limit for the real income, then the income doubles in the form.
  const limit = Math.round((a.income.stated * 0.25) / 1000) * 1000;
  apply({
    ...stacker,
    visit: [
      [
        -9,
        "visit_started",
        {
          referrer: "loan comparison site",
          landing_page: "personal loans",
          browser: "chrome",
          bot: false,
          browser_consistent: true,
        },
      ],
      [
        -8,
        "loan_calculator_used",
        { amount_usd: stacker.loan.usd, term_months: 60, annual_income_usd: a.income.stated },
      ],
      [
        -7.5,
        "offer_shown",
        {
          max_amount_usd: limit,
          text: `With an income of ${a.income.stated.toLocaleString("en-US")} dollars you can borrow up to ${limit.toLocaleString("en-US")} dollars.`,
        },
      ],
      [
        -6,
        "loan_calculator_used",
        { amount_usd: stacker.loan.usd, term_months: 60, annual_income_usd: stacker.income.stated },
      ],
      [
        (stacker.minutesToComplete / 7) * 4 - 0.5,
        "field_corrected",
        { field: "annual income", from: a.income.stated, to: stacker.income.stated },
      ],
    ],
  });
}

const action = await kairos.defineAction("loan_application", template("loan_application"));
console.log(`action ${action.name}@${action.version}`);

for (const { app, outcome } of past) track(app, outcome);
for (const app of pending) track(app);
await kairos.flush();
for (const { app, labels } of past) for (const label of labels) await kairos.label({ type: "user", id: app.id }, label);
console.log(`${past.length} past borrowers, ${pending.length} pending applications\n`);

const results: { app: Application; decision: Decision; ms: number }[] = [];
for (const app of pending) {
  const started = Date.now();
  const decision = await kairos.decide({
    type: "loan_application",
    userId: app.id,
    entities: {
      device: app.device,
      ip: app.ip.address,
      phone: app.phone,
      address: app.address,
      ssn: app.ssn.token,
      bank_account: app.bank.id,
    },
    product: "personal_loan",
    amount_usd: app.loan.usd,
    term_months: app.loan.termMonths,
    stated_annual_income_usd: app.income.stated,
    $session: app.session,
  });
  results.push({ app, decision, ms: Date.now() - started });
}
await kairos.shutdown();

const KINDS: Kind[] = [
  "clean",
  "clean_thin_file",
  "clean_household",
  "synthetic_identity",
  "identity_theft",
  "loan_stacking",
];
const EXPECTED: Record<Kind, string> = {
  clean: "legit",
  clean_thin_file: "legit",
  clean_household: "legit",
  synthetic_identity: "synthetic_identity",
  identity_theft: "identity_theft",
  loan_stacking: "first_party_fraud",
};
const honest = (kind: Kind) => EXPECTED[kind] === "legit";
console.log("kind                n  mean risk  approve  review  block  typology right");
for (const kind of KINDS) {
  const rows = results.filter((x) => x.app.kind === kind);
  const count = (outcome: string) => rows.filter((x) => x.decision.decision === outcome).length;
  const right = rows.filter((x) => x.decision.typology === EXPECTED[kind]).length;
  const mean = Math.round(rows.reduce((a, x) => a + x.decision.riskScore, 0) / rows.length);
  console.log(
    `${kind.padEnd(18)} ${String(rows.length).padStart(2)}  ${String(mean).padStart(9)}  ${String(count("approve")).padStart(7)}  ${String(count("review")).padStart(6)}  ${String(count("block")).padStart(5)}  ${String(right).padStart(14)}`,
  );
}
const bad = results.filter((x) => !honest(x.app.kind));
const good = results.filter((x) => honest(x.app.kind));
const stopped = (x: (typeof results)[number]) => x.decision.decision !== "approve";
const times = results.map((x) => x.ms).sort((a, b) => a - b);
console.log(`\nfraudulent applications not approved: ${bad.filter(stopped).length} of ${bad.length}`);
console.log(`honest applications not approved:     ${good.filter(stopped).length} of ${good.length}`);
console.log(`decide() median ${times[Math.floor(times.length / 2)]} ms, max ${times.at(-1)} ms\n`);

for (const kind of KINDS) {
  for (const { app, decision } of results.filter((x) => x.app.kind === kind)) {
    console.log(
      `${kind.padEnd(18)} ${app.id}  ${decision.decision.padEnd(7)} ${String(decision.riskScore).padStart(3)}  ${(decision.typology ?? "").padEnd(18)} ${decision.reasons.join(", ")}`,
    );
  }
}

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
