/**
 * Health insurance claims from providers, end to end against a local server.
 *
 *   pnpm api
 *   pnpm example:medical
 *
 * A health insurer decides whether a provider's claim can be paid, or must be held for
 * pre-payment review. The subject is the provider (the clinician who gave the care), not
 * the patient: most of the money lost in health claims is lost through providers. The
 * entities that link providers together are the owner, the bank account, the practice
 * address, the patients and the referring doctor. The lab is sent but does not link: two
 * national labs serve almost every provider, and in testing the model read a busy lab
 * as a link to an excluded provider although its share of them was below normal.
 *
 * Patients are members of the health plan and are sent as tokens, never as names or
 * dates of birth. A claim names its procedure and diagnosis codes, the minutes the code
 * stands for, and how far the patient lives from the practice. Real claims carry
 * protected health information: send only what the decision needs, and run the server
 * and the model calls under the agreements that the law requires.
 *
 * Each provider has peer figures for its specialty as properties (the share of
 * highest-level visits among peers), as an insurer keeps them. Two totals are exact:
 * the minutes billed in the last 24 hours, and the money billed in a week against a
 * usual week. A policy rule holds a claim when more than 1,440 minutes were billed in
 * 24 hours, whatever the model says.
 *
 * Seven kinds of provider are generated. Two are honest (one of them deliberately
 * unusual), five are not:
 *
 *   clean               a family practice with ordinary visits
 *   clean_unusual       honest, with something a rule would trip on: an oncologist
 *                       whose visits are mostly the highest level, an urgent care
 *                       clinician in a flu outbreak, a doctor who enrolled three weeks
 *                       ago, a practice whose patients' ids were stolen and billed by a
 *                       phantom clinic last year
 *   phantom_billing     a clinic that bills a bought list of member ids: far away,
 *                       seven days a week, more hours than a day has
 *   upcoding            real patients and real visits, moved from level 3 to level 5
 *                       a month ago, with the same simple diagnoses
 *   kickback_scheme     new clinics that see recruited patients sent by one doctor
 *                       and send every one of them to one lab for genetic tests, like
 *                       clinics that were found to be fraud before
 *   excluded_provider   a provider excluded last year, back under a new name with the
 *                       same owner or the same bank account
 *
 * Claims are entered in the insurer's provider portal, and each portal visit carries
 * `$session`. An honest office signs in from its own computer, checks the patients'
 * eligibility and enters the day's claims. A phantom biller signs in from a new device
 * on a VPN, changes the account the insurer pays into, and uploads a batch of claims
 * with no eligibility checks. An upcoder resubmits denied claims at a higher level. The
 * ring's clinics share one portal computer, and an excluded provider's computer comes
 * back with the new name. The portal device is a link.
 *
 * All providers, patients and businesses are invented. The scenarios and the action
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
  maxQueueSize: 200_000,
  decideTimeoutMs: 30_000,
  onError: (error) => console.error("delivery failed:", error.message),
});

// Event ids are stable, so running the example twice does not store the events twice.
let sequence = 0;
const send = kairos.track.bind(kairos);
kairos.track = (type, properties = {}) => send(type, { eventId: `health_claims_${++sequence}`, ...properties });

const r = new Rng(6619);
const DAY = 24 * 60;
/** A moment `days` ago, at a given hour of that day. */
const at = (days: number, hour = r.int(8, 17), minute = r.int(0, 59)) =>
  new Date(Math.floor((Date.now() - days * DAY * 60_000) / 86_400_000) * 86_400_000 + (hour * 60 + minute) * 60_000);
const isoDay = (days: number) => at(days, 12, 0).toISOString().slice(0, 10);
const weekend = (days: number) => [0, 6].includes(at(days, 12, 0).getUTCDay());
const HISTORY = 45;

let serial = 0;
// Ids carry "hc" so that they never meet the ids of another example in the same account.
const next = (prefix: string) => `${prefix}_hc${String(++serial).padStart(4, "0")}`;
const street = () =>
  `${r.int(100, 9900)} ${r.pick(["Main", "Park", "Medical Center", "Oak", "Lake", "Church"])} ${r.pick(["St", "Ave", "Dr", "Blvd"])}`;

type Kind = "clean" | "clean_unusual" | "phantom_billing" | "upcoding" | "kickback_scheme" | "excluded_provider";
/** Something done in a portal visit, in minutes from a moment in it: a negative minute is before it. */
type Step = [minute: number, type: string, properties?: Record<string, unknown>];

/** A billing code: what it is, the minutes it stands for, and what it pays. */
interface Code {
  code: string;
  description: string;
  minutes: number;
  usd: number;
  level?: number;
}
const CODES: Record<string, Code> = {
  "99203": { code: "99203", description: "office visit, new patient, level 3", minutes: 30, usd: 120, level: 3 },
  "99204": { code: "99204", description: "office visit, new patient, level 4", minutes: 45, usd: 190, level: 4 },
  "99205": { code: "99205", description: "office visit, new patient, level 5", minutes: 60, usd: 250, level: 5 },
  "99213": {
    code: "99213",
    description: "office visit, established patient, level 3",
    minutes: 20,
    usd: 105,
    level: 3,
  },
  "99214": {
    code: "99214",
    description: "office visit, established patient, level 4",
    minutes: 30,
    usd: 155,
    level: 4,
  },
  "99215": {
    code: "99215",
    description: "office visit, established patient, level 5",
    minutes: 40,
    usd: 215,
    level: 5,
  },
  "96413": { code: "96413", description: "chemotherapy infusion, first hour", minutes: 60, usd: 310 },
};
const SIMPLE_DX = [
  "I10 essential hypertension",
  "E11.9 type 2 diabetes without complications",
  "J06.9 upper respiratory infection",
  "M54.50 low back pain",
  "Z00.00 routine adult exam",
  "E78.5 high cholesterol",
];
const ONCOLOGY_DX = [
  "C50.911 malignant neoplasm of right breast",
  "C34.90 malignant neoplasm of lung",
  "C18.9 malignant neoplasm of colon",
  "D70.1 neutropenia after chemotherapy",
];
const FLU_DX = [
  "J10.1 influenza with respiratory symptoms",
  "J10.1 influenza with respiratory symptoms",
  "J02.9 acute pharyngitis",
  "R50.9 fever",
];

interface Provider {
  id: string;
  kind: Kind;
  specialty: string;
  /** The share of highest-level visits among peers of the same specialty. */
  peerLevel5: number;
  owner: string;
  bank: string;
  address: string;
  /** Days ago the provider enrolled with the insurer. */
  enrolledDays: number;
  /** Established patients: member tokens. */
  panel: string[];
  lab: string;
  /** The computer the office signs in to the provider portal from. */
  portalDevice: string;
}

const LABS = [next("lab"), next("lab")]; // two large national labs, used by almost everyone
const member = () => next("mbr");
const panel = (size: number) => Array.from({ length: size }, member);

function provider(kind: Kind, o: Partial<Provider> = {}): Provider {
  return {
    id: next("prv"),
    kind,
    specialty: "family medicine",
    peerLevel5: 0.07,
    owner: next("own"),
    bank: next("ba"),
    address: `${street()}, ${r.pick(["Columbus OH", "Dayton OH", "Toledo OH", "Akron OH"])}`,
    enrolledDays: r.int(700, 4000),
    panel: panel(160),
    lab: r.pick(LABS),
    portalDevice: next("dev"),
    ...o,
  };
}

interface Visit {
  member: string;
  code: Code;
  diagnosis: string;
  distanceMiles: number;
  referringProvider?: string;
  lab?: string;
  test?: { description: string; usd: number };
}

/** Claims in the past are already paid; the pending one is only submitted. */
function claim(
  p: Provider,
  when: Date,
  v: Visit,
  status: "PAID" | "SUBMITTED" = "PAID",
  $session?: string,
  service = when,
) {
  const id = next("clm");
  kairos.track("claim_submitted", {
    ...($session ? { $session } : {}),
    providerId: p.id,
    universalId: id,
    status,
    entities: {
      member: v.member,
      ...(v.referringProvider ? { referring_provider: v.referringProvider } : {}),
      ...(v.lab ? { lab: v.lab } : {}),
    },
    service_date: service.toISOString().slice(0, 10),
    service_time: service.toISOString().slice(11, 16),
    procedure_code: v.code.code,
    procedure: v.code.description,
    minutes: v.code.minutes,
    billed_usd: v.code.usd + (v.test?.usd ?? 0),
    diagnosis: v.diagnosis,
    patient_distance_miles: v.distanceMiles,
    ...(v.test ? { test_ordered: v.test.description } : {}),
    place_of_service: "office",
    timestamp: when,
  });
  return id;
}

/** Enrolment, peer figures and the bank account: what the insurer knows about a provider. */
async function enrol(p: Provider) {
  kairos.track("provider_enrolled", {
    providerId: p.id,
    entities: { owner: p.owner, bank_account: p.bank, address: p.address },
    specialty: p.specialty,
    timestamp: at(p.enrolledDays, 10),
  });
}

/** An ordinary visit at a family practice: mostly level 3 and 4, simple diagnoses, patients nearby. */
const ordinaryVisit = (p: Provider, levels: number[] = [5, 4, 1]): Visit => ({
  member: r.pick(p.panel),
  code: CODES[r.weighted(["99213", "99214", "99215"], levels)]!,
  diagnosis: r.pick(SIMPLE_DX),
  distanceMiles: r.int(1, 18),
  ...(r.chance(0.15) ? { lab: p.lab, test: { description: "basic metabolic panel", usd: 35 } } : {}),
});

/** Events that only a portal visit has: sign-ins, eligibility checks, uploads. Each carries the session of its visit. */
function portal(p: Provider, $session: string, when: Date, steps: Step[]) {
  for (const [minute, type, properties] of steps)
    kairos.track(type, {
      providerId: p.id,
      ...properties,
      $session,
      timestamp: new Date(when.getTime() + minute * 60_000),
    });
}

/** An office's usual portal visit: its own computer, eligibility checks, claims typed in. */
const officeVisit = (p: Provider, claims: number, members: string[]): Step[] => [
  [-25, "portal_login", { entities: { device: p.portalDevice }, ip_network: "business" }],
  ...members
    .slice(0, 3)
    .map((m, n): Step => [-20 + n, "eligibility_checked", { entities: { member: m }, result: "active coverage" }]),
  [-12, "claims_entered", { count: claims, method: "typed one by one" }],
];

/** Weekday office life from `fromDay` days ago up to `toDay`, with a portal visit at the end of each week. */
function practice(
  p: Provider,
  fromDay: number,
  toDay: number,
  perDay: [number, number],
  visit: (p: Provider, day: number) => Visit,
  o: { weekends?: boolean; hours?: [number, number] } = {},
) {
  for (let d = fromDay; d > toDay; d--) {
    if (weekend(d) && !o.weekends) continue;
    const visits = Array.from({ length: r.int(...perDay) }, () => visit(p, d));
    for (const v of visits) claim(p, at(d, r.int(...(o.hours ?? [8, 16]))), v);
    if (d % 7 === 0)
      portal(
        p,
        next("sess"),
        at(d, 18, 30),
        officeVisit(
          p,
          visits.length * 5,
          visits.map((v) => v.member),
        ),
      );
  }
}

const labels: { id: string; label: string }[] = [];
const providers: Provider[] = [];
const pending: { p: Provider; visit: Visit; portal?: Step[] }[] = [];

// A phantom clinic from last year. Among the ids it billed were patients of an honest practice.
const victimPractice = provider("clean_unusual");
const pastPhantom = provider("phantom_billing", { enrolledDays: 420 });
providers.push(pastPhantom);
practice(
  pastPhantom,
  300,
  240,
  [40, 55],
  () => ({
    member: r.chance(0.3) ? r.pick(victimPractice.panel) : member(),
    code: CODES["99214"]!,
    diagnosis: r.pick(SIMPLE_DX),
    distanceMiles: r.int(150, 400),
  }),
  { weekends: true, hours: [7, 22] },
);
labels.push({ id: pastPhantom.id, label: "fraud_recovered" });

// A kickback ring: one referring doctor, one lab, a pool of recruited patients, three clinics found out.
const RING_DOCTOR = next("ref");
const RING_LAB = next("lab");
const RECRUITED = panel(70);
const RING_PORTAL = next("dev"); // one computer that signs in for every clinic of the ring
const ringVisit = (): Visit => ({
  member: r.pick(RECRUITED),
  code: CODES["99205"]!,
  diagnosis: r.pick([
    "Z13.79 screening for genetic disorder",
    "Z80.3 family history of breast cancer",
    "Z13.89 screening, other",
  ]),
  distanceMiles: r.int(8, 40),
  referringProvider: RING_DOCTOR,
  lab: RING_LAB,
  test: { description: "hereditary cancer genetic panel", usd: r.pick([3200, 3800, 4400]) },
});
for (let i = 0; i < 3; i++) {
  const p = provider("kickback_scheme", {
    specialty: "internal medicine",
    enrolledDays: r.int(200, 400),
    panel: [],
    portalDevice: RING_PORTAL,
  });
  providers.push(p);
  practice(p, r.int(160, 190), r.int(90, 120), [8, 14], ringVisit);
  labels.push({ id: p.id, label: "fraud_recovered" });
}

// Providers excluded last year, whose owner or bank account comes back.
const excluded = [0, 1, 2].map(() => {
  const p = provider("excluded_provider", { enrolledDays: r.int(900, 1500) });
  providers.push(p);
  practice(p, 400, 330, [14, 20], (q) => ordinaryVisit(q));
  labels.push({ id: p.id, label: "excluded_provider" });
  return p;
});

// Background: ordinary practices, so that the large labs and the address area look normal.
for (let i = 0; i < 6; i++) {
  const p = provider("clean");
  providers.push(p);
  practice(p, HISTORY, 0, [10, 16], (q) => ordinaryVisit(q));
}

for (let i = 0; i < 8; i++) {
  const p = provider("clean");
  providers.push(p);
  practice(p, HISTORY, 0, [10, 16], (q) => ordinaryVisit(q));
  pending.push({ p, visit: ordinaryVisit(p) });
}

{
  // An oncologist: most visits are level 5, and so are the peers', for patients in chemotherapy.
  const p = provider("clean_unusual", { specialty: "medical oncology", peerLevel5: 0.58, panel: panel(90) });
  providers.push(p);
  const visit = (q: Provider): Visit => ({
    member: r.pick(q.panel),
    code: CODES[r.weighted(["99215", "99214", "96413"], [6, 2, 3])]!,
    diagnosis: r.pick(ONCOLOGY_DX),
    distanceMiles: r.int(3, 60),
    lab: q.lab,
    test: { description: "complete blood count", usd: 30 },
  });
  practice(p, HISTORY, 0, [9, 13], visit);
  pending.push({ p, visit: visit(p) });
}
{
  // Urgent care in a flu outbreak: twice the usual visits for ten days, all with flu, all nearby.
  const p = provider("clean_unusual", { specialty: "urgent care", peerLevel5: 0.04, panel: panel(400) });
  providers.push(p);
  const visit = (q: Provider): Visit => ({
    member: r.chance(0.5) ? r.pick(q.panel) : member(),
    code: CODES[r.weighted(["99213", "99214", "99203"], [6, 2, 2])]!,
    diagnosis: r.pick(FLU_DX),
    distanceMiles: r.int(1, 12),
    lab: q.lab,
    test: { description: "rapid influenza test", usd: 25 },
  });
  practice(p, HISTORY, 10, [14, 20], (q) => ({ ...visit(q), diagnosis: r.pick(SIMPLE_DX) }), {
    weekends: true,
    hours: [8, 19],
  });
  practice(p, 10, 0, [28, 36], visit, { weekends: true, hours: [8, 19] });
  kairos.track("public_health_notice", {
    providerId: p.id,
    text: "County health department: influenza A outbreak, emergency rooms and urgent care centres report visits at twice the seasonal level.",
    timestamp: at(9, 9),
  });
  pending.push({ p, visit: visit(p) });
}
{
  // A doctor who enrolled three weeks ago: little history, all new patients, nothing else unusual.
  const p = provider("clean_unusual", { enrolledDays: 21, panel: panel(60) });
  providers.push(p);
  const visit = (q: Provider): Visit => ({ ...ordinaryVisit(q), code: CODES[r.weighted(["99203", "99204"], [6, 4])]! });
  practice(p, 18, 0, [4, 8], visit);
  pending.push({ p, visit: visit(p) });
}
{
  // The practice whose patients' ids the phantom clinic billed last year.
  const p = victimPractice;
  providers.push(p);
  practice(p, HISTORY, 0, [10, 16], (q) => ordinaryVisit(q));
  pending.push({ p, visit: ordinaryVisit(p) });
}

for (let i = 0; i < 3; i++) {
  const p = provider("phantom_billing", { enrolledDays: r.int(120, 300), panel: panel(60) });
  providers.push(p);
  practice(p, HISTORY, 22, [8, 12], (q) => ordinaryVisit(q));
  // A bought list of member ids: far away, every day of the week, morning to night.
  const visit = (): Visit => ({
    member: member(),
    code: CODES[r.weighted(["99214", "99204"], [7, 3])]!,
    diagnosis: r.pick(SIMPLE_DX),
    distanceMiles: r.int(140, 420),
  });
  const usual = p.portalDevice;
  p.portalDevice = next("dev");
  practice(p, 22, 0, [42, 58], visit, { weekends: true, hours: [7, 22] });
  for (const days of [r.int(5, 12), r.int(1, 4)]) {
    kairos.track("member_complaint", {
      providerId: p.id,
      text: "My explanation of benefits shows a visit to this clinic. I have never been there, it is three hours from where I live.",
      timestamp: at(days, 11),
    });
  }
  pending.push({
    p,
    visit: visit(),
    portal: [
      [-7, "portal_login", { entities: { device: p.portalDevice }, ip_network: "vpn", usual_device: usual }],
      [-6, "payment_account_changed", { entities: { bank_account: next("ba") }, account_age_days: r.int(2, 9) }],
      [-3, "claims_file_uploaded", { claims: r.int(48, 60), format: "837P batch", eligibility_checks: 0 }],
    ],
  });
}

for (let i = 0; i < 3; i++) {
  const p = provider("upcoding");
  providers.push(p);
  practice(p, HISTORY, 28, [16, 22], (q) => ordinaryVisit(q));
  practice(p, 28, 0, [16, 22], (q) => ordinaryVisit(q, [1, 2, 8]));
  const visit = ordinaryVisit(p, [0, 0, 1]);
  pending.push({
    p,
    visit,
    portal: [
      [-32, "portal_login", { entities: { device: p.portalDevice }, ip_network: "business" }],
      [
        -29,
        "denied_claims_viewed",
        { count: 6, denial_reason: "the documentation does not support the level of service billed" },
      ],
      ...[0, 1, 2, 3].map((n): Step => [
        -26 + n * 3,
        "claim_resubmitted",
        { original_code: "99214", new_code: "99215", note_changed: false },
      ]),
      [-12, "claims_entered", { count: r.int(14, 20), method: "typed one by one" }],
    ],
  });
}

for (let i = 0; i < 3; i++) {
  const p = provider("kickback_scheme", {
    specialty: "internal medicine",
    enrolledDays: r.int(40, 80),
    panel: [],
    portalDevice: RING_PORTAL,
  });
  providers.push(p);
  practice(p, Math.min(HISTORY, p.enrolledDays - 5), 0, [8, 14], ringVisit);
  pending.push({
    p,
    visit: ringVisit(),
    portal: [
      [-18, "portal_login", { entities: { device: RING_PORTAL }, ip_network: "business" }],
      [-16, "referrals_received", { entities: { referring_provider: RING_DOCTOR }, count: r.int(9, 14) }],
      [-6, "claims_entered", { count: r.int(9, 14), method: "copied from a previous claim" }],
    ],
  });
}

for (let i = 0; i < 3; i++) {
  const old = excluded[i]!;
  const p = provider("excluded_provider", {
    enrolledDays: r.int(30, 60),
    ...(i === 0 ? { owner: old.owner } : i === 1 ? { bank: old.bank } : { address: old.address, owner: old.owner }),
    portalDevice: old.portalDevice,
  });
  providers.push(p);
  practice(p, p.enrolledDays - 3, 0, [10, 16], (q) => ordinaryVisit(q));
  pending.push({ p, visit: ordinaryVisit(p) });
}

const action = await kairos.defineAction("medical_claim", template("medical_claim"));
console.log(`action ${action.name}@${action.version}`);
for (const p of providers) await enrol(p);
await kairos.flush();
for (const p of providers)
  await kairos.setObject("provider", p.id, {
    specialty: p.specialty,
    peer_share_of_level_5_visits: p.peerLevel5,
    enrolled: isoDay(p.enrolledDays),
  });
for (const { id, label } of labels) await kairos.label({ type: "provider", id }, label);
console.log(
  `${providers.length} providers, ${sequence} events, ${labels.length} outcome labels, ${pending.length} pending claims\n`,
);

const results: { kind: Kind; decision: Decision; id: string; ms: number }[] = [];
for (const { p, visit, portal: steps } of pending) {
  const now = new Date(Date.now() - 60_000);
  const session = next("sess");
  portal(p, session, now, steps ?? officeVisit(p, r.int(8, 15), [visit.member, ...p.panel.slice(0, 2)]));
  // The visit was on the last working day, or last night for a clinic that bills every day; it is sent now.
  let day = 1;
  while (weekend(day) && p.kind !== "phantom_billing") day++;
  const service = p.kind === "phantom_billing" ? at(1, r.int(19, 22)) : at(day, r.int(9, 16));
  const claimId = claim(p, now, visit, "SUBMITTED", session, service);
  await kairos.flush();
  const started = Date.now();
  const decision = await kairos.decide({
    type: "medical_claim",
    entities: {
      provider: p.id,
      claim: claimId,
      member: visit.member,
      owner: p.owner,
      bank_account: p.bank,
      address: p.address,
      device: p.portalDevice,
      ...(visit.referringProvider ? { referring_provider: visit.referringProvider } : {}),
      ...(visit.lab ? { lab: visit.lab } : {}),
    },
    procedure_code: visit.code.code,
    procedure: visit.code.description,
    diagnosis: visit.diagnosis,
    billed_usd: visit.code.usd + (visit.test?.usd ?? 0),
    ...(visit.test ? { test_ordered: visit.test.description } : {}),
    patient_distance_miles: visit.distanceMiles,
    $session: session,
  });
  results.push({ kind: p.kind, decision, id: p.id, ms: Date.now() - started });
}
await kairos.shutdown();

const KINDS: Kind[] = ["clean", "clean_unusual", "phantom_billing", "upcoding", "kickback_scheme", "excluded_provider"];
const EXPECTED: Record<Kind, string> = {
  clean: "legit",
  clean_unusual: "legit",
  phantom_billing: "phantom_billing",
  upcoding: "upcoding",
  kickback_scheme: "kickback_scheme",
  excluded_provider: "excluded_provider",
};
const honest = (kind: Kind) => EXPECTED[kind] === "legit";
console.log("MEDICAL CLAIMS  (approve = pay)");
console.log("kind               n  mean risk  approve  review  block  typology right");
for (const kind of KINDS) {
  const rows = results.filter((x) => x.kind === kind);
  const count = (outcome: string) => rows.filter((x) => x.decision.decision === outcome).length;
  const right = rows.filter((x) => x.decision.typology === EXPECTED[kind]).length;
  const mean = Math.round(rows.reduce((a, x) => a + x.decision.riskScore, 0) / rows.length);
  console.log(
    `${kind.padEnd(17)} ${String(rows.length).padStart(2)}  ${String(mean).padStart(9)}  ${String(count("approve")).padStart(7)}  ${String(count("review")).padStart(6)}  ${String(count("block")).padStart(5)}  ${String(right).padStart(14)}`,
  );
}
const bad = results.filter((x) => !honest(x.kind));
const good = results.filter((x) => honest(x.kind));
const stopped = (x: (typeof results)[number]) => x.decision.decision !== "approve";
const times = results.map((x) => x.ms).sort((a, b) => a - b);
console.log(`\nfraudulent claims held: ${bad.filter(stopped).length} of ${bad.length}`);
console.log(`honest claims held:     ${good.filter(stopped).length} of ${good.length}`);
console.log(`decide() median ${times[Math.floor(times.length / 2)]} ms, max ${times.at(-1)} ms\n`);

for (const kind of KINDS) {
  for (const { decision, id } of results.filter((x) => x.kind === kind)) {
    console.log(
      `${kind.padEnd(17)} ${id}  ${decision.decision.padEnd(7)} ${String(decision.riskScore).padStart(3)}  ${(decision.typology ?? "").padEnd(17)} ${[...decision.reasons, ...decision.rules.map((rule) => `rule:${rule}`)].join(", ")}`,
    );
  }
}

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
