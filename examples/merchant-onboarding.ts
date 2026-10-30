/**
 * Merchant onboarding, end to end against a local server.
 *
 *   pnpm api
 *   pnpm example:merchants
 *
 * A payments company decides whether to approve a merchant application. The subject is
 * a merchant; the entities that link merchants together are the IP address, the device,
 * the payout bank account, the owner, the email domain and the website.
 *
 * Six kinds of application are generated. Two are honest (one of them deliberately
 * unusual), four are not:
 *
 *   clean            an ordinary business applying for itself
 *   clean_unusual    honest, but with something a rule would trip on: an accountant
 *                    onboarding clients from one office, an owner with a second
 *                    business, a sole trader on a free email, a corporate VPN
 *   merchant_farm    one operator, many applications: same datacenter IP, shared
 *                    devices, minutes apart, throwaway email domains
 *   stolen_identity  a real business's details used from abroad, with a new bank
 *                    account in another name and a form pasted in three minutes
 *   reapplication    a terminated merchant back under a new name, given away by the
 *                    owner or the bank account
 *   laundering_front a harmless declared business whose website sells something else
 *
 * The signal vocabulary (shared IP, shared device, shared email domain, VPN and
 * datacenter networks) follows the fraud scenarios in finic-simulator. All data is
 * synthetic and written for this example, so the output shows that the path works
 * for a second domain. It does not measure accuracy.
 */
import { Rng } from "../packages/eval/src/rng";
import { Kairos, type Decision } from "../packages/sdk/src/index.js";
import { template } from "../templates/index";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY ?? missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  flushAt: 500,
  decideTimeoutMs: 30_000,
  onError: (error) => console.error("delivery failed:", error.message),
});

const r = new Rng(20261007);
const DAY = 24 * 60;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

type Network = "business" | "residential" | "mobile" | "vpn" | "datacenter";
type Kind = "clean" | "clean_unusual" | "merchant_farm" | "stolen_identity" | "reapplication" | "laundering_front";

interface Application {
  id: string;
  kind: Kind;
  legalName: string;
  category: string;
  country: string;
  registrationAgeYears: number;
  monthlyVolumeUsd: number;
  ip: { address: string; country: string; network: Network };
  device: string;
  emailDomain: string;
  website: { domain: string; ageDays: number; review: string };
  bank: { id: string; country: string; ageDays: number; holderNameMatch: boolean };
  owner: { id: string; country: string; document: "passed" | "failed" };
  minutesToComplete: number;
  pastedFields: number;
  /** Minutes before now that the application started. */
  startedAgo: number;
}

const COUNTRIES = ["GB", "IE", "NL", "DE", "PT", "ES"];
const ABROAD = ["VN", "RO", "NG", "BR", "TR", "ID"];
const FREE_MAIL = ["gmail.com", "outlook.com", "yahoo.com", "proton.me"];
const THROWAWAY_MAIL = ["mailbox-drop.net", "quickinbox.io", "tempmail-box.org"];
const BUSINESSES: [name: string, category: string][] = [
  ["Harbour Street Bakery", "bakery"],
  ["Northgate Cycles", "bicycle shop"],
  ["Lumen Dental Studio", "dental practice"],
  ["Fernhill Garden Supplies", "garden centre"],
  ["Castle Lane Books", "bookshop"],
  ["Tidewater Coffee Roasters", "coffee roaster"],
  ["Greyfriars Physio", "physiotherapy clinic"],
  ["Orchard Row Florist", "florist"],
  ["Kestrel Print Works", "print shop"],
  ["Millbrook Pet Supplies", "pet shop"],
  ["Saltmarsh Ceramics", "ceramics studio"],
  ["Oakfield Tutoring", "tutoring service"],
  ["Riverside Auto Repair", "car repair"],
  ["Brightwell Opticians", "optician"],
  ["Juniper Yoga Studio", "yoga studio"],
  ["Stonebridge Catering", "catering"],
  ["Lantern Quay Hostel", "accommodation"],
  ["Pinecrest Carpentry", "carpentry"],
  ["Windmill Hill Brewery", "brewery"],
  ["Hollybank Nursery School", "childcare"],
  ["Arcadia Phone Repairs", "phone repair"],
  ["Elmstead Accounting", "accounting"],
  ["Marlowe Tailoring", "tailor"],
  ["Sable Court Jewellers", "jeweller"],
];
const FARM_NAMES = [
  "Nova Trade Hub",
  "Zenix Global Store",
  "Primecart Online",
  "Vertex Goods Ltd",
  "Bluepeak Market",
  "Omni Retail Point",
  "Swiftbuy Direct",
  "Astra Commerce",
  "Polar Deals Shop",
];
const GOOD_REVIEW =
  "Product and service pages, prices, a contact page and a returns policy. Content matches the declared business.";
const THIN_REVIEW =
  "Single-page template site. Stock photos, placeholder text in two sections, no company details and no working contact form.";
const FRONT_REVIEWS = [
  "Site lists six products with stock photos. The checkout button redirects to a different domain that sells online casino credits.",
  "Storefront shows phone accessories. Hidden pages found by the crawler offer prescription medicines with worldwide shipping and no prescription.",
  "Declared as a consulting firm. The payment page text refers to 'account top-ups' and 'betting balance', and the terms mention wagering.",
  "Bookshop catalogue has eleven titles. Most traffic lands on an unlinked page that sells replica designer watches and handbags.",
];

const ip = () => `${r.int(23, 212)}.${r.int(1, 254)}.${r.int(1, 254)}.${r.int(2, 250)}`;
const datacenterIp = () => `${r.pick(["104.238", "185.220", "45.33", "162.247"])}.${r.int(1, 254)}.${r.int(2, 250)}`;
const slug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, "");
let serial = 0;
const next = (prefix: string) => `${prefix}_${String(++serial).padStart(4, "0")}`;
const names = [...BUSINESSES];
const business = () => names.splice(r.int(0, names.length - 1), 1)[0] ?? [`Trading Co ${serial}`, "retail"];

/** An ordinary, honest application. Every other kind starts from this and changes a few things. */
function clean(kind: Kind, startedAgo: number): Application {
  const [legalName, category] = business();
  const country = r.pick(COUNTRIES);
  const domain = `${slug(legalName)}.${country === "GB" ? "co.uk" : country.toLowerCase()}`;
  return {
    id: next("mer"),
    kind,
    legalName,
    category,
    country,
    registrationAgeYears: r.int(2, 14),
    monthlyVolumeUsd: r.pick([8000, 15000, 25000, 40000, 60000]),
    ip: { address: ip(), country, network: r.pick(["business", "business", "residential", "mobile"] as Network[]) },
    device: next("dev"),
    emailDomain: domain,
    website: { domain, ageDays: r.int(500, 3600), review: GOOD_REVIEW },
    bank: { id: next("ba"), country, ageDays: r.int(400, 4000), holderNameMatch: true },
    owner: { id: next("own"), country, document: "passed" },
    minutesToComplete: r.int(16, 48),
    pastedFields: r.int(0, 2),
    startedAgo,
  };
}

/** Send the events of one application. `outcome` adds the result for merchants decided in the past. */
function track(a: Application, outcome?: "application_approved" | "application_rejected") {
  const merchantId = a.id;
  const at = (offset: number) => ago(a.startedAgo - offset);
  const step = a.minutesToComplete / 7;
  kairos.track("application_started", {
    merchantId,
    entities: { ip: a.ip.address, device: a.device },
    ip_country: a.ip.country,
    timestamp: at(0),
  });
  kairos.track("email_verified", {
    merchantId,
    entities: { email_domain: a.emailDomain },
    free_or_throwaway_provider: [...FREE_MAIL, ...THROWAWAY_MAIL].includes(a.emailDomain),
    timestamp: at(step),
  });
  kairos.track("business_details_submitted", {
    merchantId,
    legal_name: a.legalName,
    category: a.category,
    country: a.country,
    registration_age_years: a.registrationAgeYears,
    declared_monthly_volume_usd: a.monthlyVolumeUsd,
    timestamp: at(step * 2),
  });
  kairos.track("owner_added", {
    merchantId,
    entities: { owner: a.owner.id },
    owner_country: a.owner.country,
    id_document: a.owner.document,
    timestamp: at(step * 3),
  });
  kairos.track("website_submitted", {
    merchantId,
    entities: { website: a.website.domain },
    domain_age_days: a.website.ageDays,
    timestamp: at(step * 4),
  });
  kairos.track("website_reviewed", {
    merchantId,
    entities: { website: a.website.domain },
    text: a.website.review,
    timestamp: at(step * 4.5),
  });
  kairos.track("bank_account_added", {
    merchantId,
    entities: { bank_account: a.bank.id },
    bank_country: a.bank.country,
    account_age_days: a.bank.ageDays,
    holder_name_matches_business: a.bank.holderNameMatch,
    timestamp: at(step * 6),
  });
  kairos.track("application_submitted", {
    merchantId,
    entities: { ip: a.ip.address, device: a.device },
    minutes_to_complete: a.minutesToComplete,
    pasted_fields: a.pastedFields,
    timestamp: at(a.minutesToComplete),
  });
  if (outcome) kairos.track(outcome, { merchantId, timestamp: at(a.minutesToComplete + 60 * r.int(4, 40)) });
  if (outcome === "application_approved") {
    // A few months of ordinary life, so that an approved merchant looks like one.
    for (let m = Math.min(6, Math.floor(a.startedAgo / (30 * DAY)) - 1); m >= 1; m--) {
      kairos.track("payout_sent", {
        merchantId,
        entities: { bank_account: a.bank.id },
        usd: Math.round(a.monthlyVolumeUsd * r.float(0.5, 1.1)),
        timestamp: ago(m * 30 * DAY),
      });
    }
  }
}

const networks = new Map<string, { country: string; network: Network }>();
const past: { app: Application; label?: string }[] = [];
const pending: Application[] = [];
const add = (a: Application) => (networks.set(a.ip.address, a.ip), a);
const history = (a: Application, label?: string) => past.push({ app: add(a), label });
const apply = (a: Application) => pending.push(add(a));
const longAgo = () => r.int(120, 900) * DAY;
const recent = () => r.int(20, 600);

// Background: merchants approved in the past, so that links have something to point at.
for (let i = 0; i < 8; i++) history(clean("clean", longAgo()));

for (let i = 0; i < 10; i++) apply(clean("clean", recent()));

// clean_unusual: honest applications that share something or look odd.
for (let office = 0; office < 2; office++) {
  // An accountant onboards clients from one office connection and one laptop.
  const first = clean("clean", longAgo());
  const second = { ...clean("clean", longAgo()), ip: first.ip, device: first.device };
  history(first);
  history(second);
  apply({ ...clean("clean_unusual", recent()), ip: first.ip, device: first.device });
}
for (let i = 0; i < 2; i++) {
  // An owner opens a second business.
  const first = clean("clean", longAgo());
  history(first);
  apply({ ...clean("clean_unusual", recent()), owner: first.owner, ip: first.ip });
}
{
  // A sole trader: free email, a three-week-old website, a home connection.
  const a = clean("clean_unusual", recent());
  apply({
    ...a,
    emailDomain: "gmail.com",
    website: { ...a.website, ageDays: 21 },
    registrationAgeYears: 0,
    monthlyVolumeUsd: 3000,
    ip: { ...a.ip, network: "residential" },
  });
}
{
  // An established company whose staff apply through the corporate VPN.
  const a = clean("clean_unusual", recent());
  apply({ ...a, ip: { ...a.ip, network: "vpn" }, registrationAgeYears: 11 });
}

// merchant_farm: three earlier members already dealt with, six more arriving within the hour.
{
  const farmIp = { address: datacenterIp(), country: "NL", network: "datacenter" as Network };
  const devices = [next("dev"), next("dev")];
  const farm = (kind: Kind, startedAgo: number, i: number): Application => {
    const a = clean(kind, startedAgo);
    const legalName = FARM_NAMES[i]!;
    const domain = `${slug(legalName)}.shop`;
    return {
      ...a,
      legalName,
      category: "general retail",
      registrationAgeYears: 0,
      monthlyVolumeUsd: r.pick([80000, 120000, 150000]),
      ip: farmIp,
      device: devices[i % 2]!,
      emailDomain: r.pick(THROWAWAY_MAIL),
      website: { domain, ageDays: r.int(3, 9), review: THIN_REVIEW },
      bank: { ...a.bank, ageDays: r.int(5, 30) },
      minutesToComplete: r.int(4, 7),
      pastedFields: r.int(9, 13),
    };
  };
  history(farm("merchant_farm", 9 * DAY, 0), "rejected_fraud");
  history(farm("merchant_farm", 9 * DAY - 14, 1), "rejected_fraud");
  history(farm("merchant_farm", 16 * DAY, 2), "terminated_fraud");
  [52, 44, 37, 29, 21, 12].forEach((startedAgo, i) => apply(farm("merchant_farm", startedAgo, i + 3)));
}

// stolen_identity: a real, established business's details in the wrong hands.
for (let i = 0; i < 4; i++) {
  const a = clean("stolen_identity", recent());
  apply({
    ...a,
    registrationAgeYears: r.int(7, 15),
    ip: { address: ip(), country: r.pick(ABROAD), network: r.pick(["residential", "vpn"] as Network[]) },
    emailDomain: r.pick(FREE_MAIL),
    bank: { id: next("ba"), country: a.country, ageDays: r.int(3, 12), holderNameMatch: false },
    owner: { ...a.owner, document: i === 0 ? "failed" : "passed" },
    minutesToComplete: r.int(2, 4),
    pastedFields: r.int(10, 14),
  });
}

// reapplication: a terminated merchant returns under a new name.
for (let i = 0; i < 4; i++) {
  const old = clean("reapplication", r.int(200, 500) * DAY);
  history(old, r.pick(["terminated_chargebacks", "terminated_fraud"]));
  const a = clean("reapplication", recent());
  apply({
    ...a,
    registrationAgeYears: 0,
    website: { ...a.website, ageDays: r.int(10, 40) },
    ...(i % 2 === 0 ? { bank: old.bank } : { owner: old.owner }),
    ip: { ...a.ip, network: "residential" },
  });
}

// laundering_front: the declared business is not what the website sells.
for (let i = 0; i < 4; i++) {
  const a = clean("laundering_front", recent());
  apply({
    ...a,
    registrationAgeYears: r.int(0, 1),
    website: { ...a.website, ageDays: r.int(40, 120), review: FRONT_REVIEWS[i]! },
    monthlyVolumeUsd: r.pick([60000, 90000]),
  });
}

const action = await kairos.defineAction("merchant_onboarding", template("merchant_onboarding"));
console.log(`action ${action.name}@${action.version}`);

for (const { app } of past) track(app, app.kind === "merchant_farm" ? "application_rejected" : "application_approved");
for (const app of pending) track(app);
await kairos.flush();
// What is known about each IP address: this is where IP intelligence from a vendor would go.
for (const [address, { country, network }] of networks) await kairos.setObject("ip", address, { country, network });
for (const { app, label } of past) if (label) await kairos.label({ type: "merchant", id: app.id }, label);
console.log(`${past.length} past merchants, ${pending.length} pending applications, ${networks.size} IP addresses\n`);

const results: { app: Application; decision: Decision; ms: number }[] = [];
for (const app of pending) {
  const started = Date.now();
  const decision = await kairos.decide({
    type: "merchant_onboarding",
    entities: {
      merchant: app.id,
      ip: app.ip.address,
      device: app.device,
      bank_account: app.bank.id,
      owner: app.owner.id,
      email_domain: app.emailDomain,
      website: app.website.domain,
    },
    category: app.category,
    country: app.country,
    declared_monthly_volume_usd: app.monthlyVolumeUsd,
  });
  results.push({ app, decision, ms: Date.now() - started });
}
await kairos.shutdown();

const KINDS: Kind[] = [
  "clean",
  "clean_unusual",
  "merchant_farm",
  "stolen_identity",
  "reapplication",
  "laundering_front",
];
const honest = (kind: Kind) => kind === "clean" || kind === "clean_unusual";
console.log("kind               n  mean risk  approve  review  block  typology right");
for (const kind of KINDS) {
  const rows = results.filter((x) => x.app.kind === kind);
  const count = (outcome: string) => rows.filter((x) => x.decision.decision === outcome).length;
  const right = rows.filter((x) => x.decision.typology === (honest(kind) ? "legit" : kind)).length;
  const mean = Math.round(rows.reduce((a, x) => a + x.decision.riskScore, 0) / rows.length);
  console.log(
    `${kind.padEnd(17)} ${String(rows.length).padStart(2)}  ${String(mean).padStart(9)}  ${String(count("approve")).padStart(7)}  ${String(count("review")).padStart(6)}  ${String(count("block")).padStart(5)}  ${String(right).padStart(14)}`,
  );
}
const bad = results.filter((x) => !honest(x.app.kind));
const good = results.filter((x) => honest(x.app.kind));
const stopped = (x: (typeof results)[number]) => x.decision.decision !== "approve";
const times = results.map((x) => x.ms).sort((a, b) => a - b);
console.log(`\nbad applications not approved:    ${bad.filter(stopped).length} of ${bad.length}`);
console.log(`honest applications not approved: ${good.filter(stopped).length} of ${good.length}`);
console.log(`decide() median ${times[Math.floor(times.length / 2)]} ms, max ${times.at(-1)} ms\n`);

for (const kind of KINDS) {
  for (const { app, decision } of results.filter((x) => x.app.kind === kind)) {
    console.log(
      `${kind.padEnd(17)} ${app.id}  ${decision.decision.padEnd(7)} ${String(decision.riskScore).padStart(3)}  ${(decision.typology ?? "").padEnd(16)} ${decision.reasons.join(", ")}`,
    );
  }
}

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
