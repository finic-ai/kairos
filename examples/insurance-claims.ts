/**
 * Motor insurance claims, end to end against a local server.
 *
 *   pnpm api
 *   pnpm example:insurance
 *
 * An insurer decides whether a motor claim can be paid automatically, or must go to a
 * claims investigator. The subject is the policyholder; the entities that link claims
 * together are the other driver, the clinic, the lawyer, the phone and the device the
 * claim was filed from. The repair shop is sent but does not link: a busy shop is
 * shared by many honest claims, and in testing the model read a busy honest shop as a
 * link to fraud. A small shop that works for a ring is still reached through the
 * people around it.
 *
 * Five kinds of claim are generated. Two are honest (one of them deliberately unusual),
 * three are not:
 *
 *   clean              a policyholder of some years, rear-ended, reported the same day
 *   clean_unusual      honest, with something a rule would trip on: a claim in the
 *                      third week of a policy that replaced another insurer's with no
 *                      gap, a second hail claim in a year, a report delayed by a stay
 *                      in hospital, a large estimate on an expensive car
 *   staged_accident    a ring: the same two "other drivers", clinic and lawyer as
 *                      earlier claims that were found to be staged, a low-speed
 *                      impact, injured passengers and a lawyer within days
 *   inflated_claim     a real collision, an estimate three times the usual cost, old
 *                      damage in the photos, an injury added weeks later
 *   pre_existing_loss  cover bought or upgraded days before the "loss", photographs
 *                      dated before the cover started, no police report
 *
 * Every claim is reported in a visit to the insurer's app, and the events of that visit
 * carry `$session`. An honest policyholder signs in on their own phone, takes the
 * photos with the app's camera and then picks a repair shop. A claim runner for the ring
 * signs in to several policyholders' accounts from one office computer in one visit and
 * pastes the same story. A policyholder with an old loss uploads photos from the
 * phone's gallery, and looked up how to make a claim in the visit where the cover was
 * bought. A policyholder about to inflate a claim first reads what the policy pays.
 *
 * All people, vehicles and businesses are invented. The scenarios and the action were
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
kairos.track = (type, properties = {}) => send(type, { eventId: `insurance_claims_${++sequence}`, ...properties });

const r = new Rng(5203);
const DAY = 24 * 60;
/** A moment `days` ago, at a given hour of that day. */
const at = (days: number, hour = r.int(8, 20), minute = r.int(0, 59)) =>
  new Date(Math.floor((Date.now() - days * DAY * 60_000) / 86_400_000) * 86_400_000 + (hour * 60 + minute) * 60_000);
const isoDay = (days: number) => at(days, 12, 0).toISOString().slice(0, 10);

let serial = 0;
// Ids carry "ins" so that they never meet the ids of another example in the same account.
const next = (prefix: string) => `${prefix}_ins${String(++serial).padStart(4, "0")}`;
const phone = () => `+1${r.int(201, 989)}${r.int(2000000, 9999999)}`;

type Kind = "clean" | "clean_unusual" | "staged_accident" | "inflated_claim" | "pre_existing_loss";
/** Something done in a visit, in minutes from a moment in it: a negative minute is before it. */
type Step = [minute: number, type: string, properties?: Record<string, unknown>];
type Cover = "liability" | "collision" | "comprehensive";

interface Policyholder {
  id: string;
  phone: string;
  device: string;
  vehicle: { id: string; model: string; valueUsd: number };
  /** Days ago the policy started. */
  policyDays: number;
  cover: Cover;
  premium: number;
  priorInsurerContinuous: boolean;
}

interface Claim {
  lossType: "rear_ended" | "intersection_collision" | "parking_lot_damage" | "hail" | "side_swipe";
  /** Days ago the loss happened. */
  lossDays: number;
  /** Days ago it was reported. */
  reportDays: number;
  description: string;
  policeReport: boolean;
  impactMph?: number;
  otherParty?: string;
  shop: string;
  estimateUsd: number;
  usualUsd: number;
  photosTaken: string;
  injuries: { clinic: string; person: string; injury: string; daysAfterLoss: number }[];
  lawyer?: { id: string; daysAfterLoss: number };
  adjusterNote?: string;
  /** The visit the claim is reported in, and what else was done there, in minutes from the report. */
  session?: string;
  visit?: Step[];
  /** When the report was made, in minutes before now, for claims that share a visit. */
  reportMinutesAgo?: number;
  photoSource?: "in-app camera" | "gallery";
}

const VEHICLES: [model: string, valueUsd: number][] = [
  ["2017 Honda Civic", 14000],
  ["2019 Toyota Camry", 21000],
  ["2016 Ford F-150", 24000],
  ["2020 Hyundai Tucson", 22000],
  ["2015 Nissan Altima", 9000],
  ["2018 Subaru Outback", 19000],
  ["2021 Kia Forte", 17000],
  ["2014 Chevrolet Malibu", 7500],
];
// Busy, honest shops: many claims go through them, almost all of them ordinary.
const SHOPS = [next("shop"), next("shop"), next("shop")];
const CLINICS = [next("clinic"), next("clinic")];

function policyholder(policyDays = r.int(400, 3000)): Policyholder {
  const [model, valueUsd] = r.pick(VEHICLES);
  return {
    id: next("ph"),
    phone: phone(),
    device: next("dev"),
    vehicle: { id: next("veh"), model, valueUsd },
    policyDays,
    cover: r.pick(["collision", "comprehensive"] as Cover[]),
    premium: r.int(90, 180),
    priorInsurerContinuous: true,
  };
}

/** The policy and its life up to `toDay` days ago: the start, monthly premiums, the odd login. */
function policyLife(p: Policyholder, toDay = 0) {
  const policyholderId = p.id;
  kairos.track("policy_started", {
    policyholderId,
    entities: { vehicle: p.vehicle.id, phone: p.phone, device: p.device },
    vehicle_model: p.vehicle.model,
    vehicle_value_usd: p.vehicle.valueUsd,
    cover: p.cover,
    premium_monthly_usd: p.premium,
    prior_insurer_continuous: p.priorInsurerContinuous,
    timestamp: at(p.policyDays, 14),
  });
  for (let d = p.policyDays - 30; d > toDay; d -= 30)
    kairos.track("premium_payment", {
      policyholderId,
      universalId: `${p.id}_prem_${d}`,
      status: "paid",
      usd: p.premium,
      timestamp: at(d, 6, 0),
    });
  for (let d = p.policyDays; d > toDay; d -= r.int(20, 60))
    kairos.track("login", { policyholderId, entities: { device: p.device }, timestamp: at(d) });
}

/** An ordinary rear-end collision, reported the same day. Every other claim starts from this. */
function ordinary(lossDays = r.int(1, 3)): Claim {
  const usualUsd = r.pick([1800, 2400, 3100, 3900]);
  return {
    lossType: "rear_ended",
    lossDays,
    reportDays: lossDays - 0.1,
    description:
      "I was stopped at a red light and the car behind me did not stop in time. The rear bumper and trunk lid are damaged. We exchanged details and the police came.",
    policeReport: true,
    impactMph: r.int(12, 25),
    otherParty: next("driver"),
    shop: r.pick(SHOPS),
    estimateUsd: Math.round(usualUsd * r.float(0.85, 1.15)),
    usualUsd,
    photosTaken: isoDay(lossDays),
    injuries: [],
  };
}

/** Events that only a visit has: sign-ins, pages, chats. Each carries the session of its visit. */
function visit(policyholderId: string, $session: string, when: Date, steps: Step[]) {
  for (const [minute, type, properties] of steps)
    kairos.track(type, {
      policyholderId,
      ...properties,
      $session,
      timestamp: new Date(when.getTime() + minute * 60_000),
    });
}

/** The usual way to report: sign in on one's own phone, open the form, then choose a repair shop. */
const filing = (p: Policyholder): Step[] => [
  [-r.int(5, 9), "login", { entities: { device: p.device } }],
  [-3, "page_viewed", { page: "report a claim" }],
  [24, "page_viewed", { page: "choose a repair shop" }],
];

/** Send a claim: reported, then its evidence. `outcome` closes a claim from the past. */
function track(p: Policyholder, c: Claim, claimId: string, outcome?: "PAID" | "DENIED_FRAUD") {
  const policyholderId = p.id;
  const report =
    c.reportMinutesAgo !== undefined
      ? new Date(Date.now() - c.reportMinutesAgo * 60_000)
      : new Date(Math.min(at(c.reportDays, outcome ? 10 : r.int(8, 22)).getTime(), Date.now() - 45 * 60_000));
  const after = (days: number) =>
    new Date(Math.min(at(c.lossDays, 12, 0).getTime() + days * DAY * 60_000, Date.now() - 60_000));
  const $session = c.session ? { $session: c.session } : {};
  if (c.session) visit(p.id, c.session, report, c.visit ?? filing(p));
  kairos.track("claim_reported", {
    ...$session,
    policyholderId,
    universalId: claimId,
    status: "OPEN",
    entities: {
      claim: claimId,
      device: p.device,
      phone: p.phone,
      vehicle: p.vehicle.id,
      ...(c.otherParty ? { other_party: c.otherParty } : {}),
    },
    loss_type: c.lossType,
    loss_date: isoDay(c.lossDays),
    police_report: c.policeReport,
    ...(c.impactMph ? { estimated_impact_mph: c.impactMph } : {}),
    description: c.description,
    timestamp: report,
  });
  kairos.track("photos_uploaded", {
    ...$session,
    policyholderId,
    entities: { claim: claimId },
    count: r.int(4, 9),
    source: c.photoSource ?? "in-app camera",
    photo_date_in_metadata: c.photosTaken,
    timestamp: new Date(report.getTime() + 20 * 60_000),
  });
  kairos.track("repair_estimate_received", {
    policyholderId,
    entities: { claim: claimId, repair_shop: c.shop },
    estimate_usd: c.estimateUsd,
    usual_cost_for_this_damage_usd: c.usualUsd,
    timestamp: after(c.lossDays - c.reportDays + 2),
  });
  for (const injury of c.injuries) {
    kairos.track("injury_claimed", {
      policyholderId,
      entities: { claim: claimId, clinic: injury.clinic },
      person: injury.person,
      injury: injury.injury,
      timestamp: after(injury.daysAfterLoss),
    });
  }
  if (c.lawyer)
    kairos.track("lawyer_letter_received", {
      policyholderId,
      entities: { claim: claimId, lawyer: c.lawyer.id },
      timestamp: after(c.lawyer.daysAfterLoss),
    });
  if (c.adjusterNote)
    kairos.track("adjuster_note", {
      policyholderId,
      entities: { claim: claimId },
      text: c.adjusterNote,
      timestamp: after(c.lossDays - c.reportDays + 3),
    });
  if (outcome)
    kairos.track("claim_reported", {
      policyholderId,
      universalId: claimId,
      status: outcome,
      timestamp: after(c.lossDays - c.reportDays + 25),
    });
}

const labels: { id: string; label: string }[] = [];
const pending: { kind: Kind; p: Policyholder; claim: Claim; id: string }[] = [];
const claim = (kind: Kind, p: Policyholder, c: Claim) =>
  pending.push({ kind, p, claim: { ...c, session: c.session ?? next("sess") }, id: next("clm") });

// Background: policyholders with ordinary paid claims at the busy shops and clinics.
for (let i = 0; i < 14; i++) {
  const p = policyholder();
  policyLife(p);
  const c = ordinary(r.int(30, 300));
  if (i % 4 === 0) c.injuries = [{ clinic: r.pick(CLINICS), person: "driver", injury: "whiplash", daysAfterLoss: 1 }];
  track(p, c, next("clm"), "PAID");
}

// The ring: two "other drivers", a clinic and a lawyer that keep coming back.
const RING_DRIVERS = [next("driver"), next("driver")];
const RING_CLINIC = next("clinic");
const RING_LAWYER = next("lawyer");
const RING_SHOP = next("shop");
const RING_OFFICE = next("dev"); // the claim runner's computer
/** The claim runner signs in to the policyholder's account from the office and pastes the story. */
const runner = (): Step[] => [
  [-2.5, "login", { entities: { device: RING_OFFICE }, ip_network: "business" }],
  [-2, "page_viewed", { page: "report a claim" }],
  [-0.5, "field_pasted", { fields: ["description", "other driver's details", "passengers"] }],
];
function staged(lossDays: number, i: number): Claim {
  const usualUsd = 1600;
  return {
    lossType: "intersection_collision",
    lossDays,
    reportDays: lossDays - 0.1,
    description:
      "The other car pulled out in front of me at the intersection and I could not stop. Everyone in my car hurt their neck and back.",
    policeReport: false,
    impactMph: r.int(5, 9),
    otherParty: RING_DRIVERS[i % 2]!,
    shop: RING_SHOP,
    estimateUsd: r.int(3800, 5200),
    usualUsd,
    photosTaken: isoDay(lossDays),
    injuries: ["driver", "passenger 1", "passenger 2"].map((person, n) => ({
      clinic: RING_CLINIC,
      person,
      injury: r.pick(["neck strain", "lower back pain", "soft tissue injury"]),
      daysAfterLoss: 1 + n,
    })),
    lawyer: { id: RING_LAWYER, daysAfterLoss: r.int(2, 4) },
  };
}
for (let i = 0; i < 4; i++) {
  const p = policyholder(r.int(150, 300));
  policyLife(p);
  track(p, { ...staged(r.int(25, 120), i), session: next("sess"), visit: runner() }, next("clm"), "DENIED_FRAUD");
  labels.push({ id: p.id, label: "claim_fraud_confirmed" });
}

for (let i = 0; i < 8; i++) {
  const p = policyholder();
  policyLife(p);
  const c = ordinary();
  if (i % 3 === 0) c.injuries = [{ clinic: r.pick(CLINICS), person: "driver", injury: "whiplash", daysAfterLoss: 1 }];
  claim("clean", p, c);
}

{
  // Three weeks into a new policy, but it replaced another insurer's with no gap, and a dash camera saw it.
  const p = { ...policyholder(21), priorInsurerContinuous: true };
  policyLife(p);
  claim("clean_unusual", p, {
    ...ordinary(2),
    description:
      "A van reversed out of a driveway into my passenger door. My dash camera recorded it and I have uploaded the video. The police took a report.",
    visit: [...filing(p), [6, "video_uploaded", { source: "dash camera", length_seconds: 42 }]],
  });
}
{
  // A second hail claim within a year: the first was paid, and the same storm hit the whole city.
  const p = { ...policyholder(), cover: "comprehensive" as Cover };
  policyLife(p);
  track(
    p,
    {
      ...ordinary(240),
      lossType: "hail",
      otherParty: undefined,
      impactMph: undefined,
      policeReport: false,
      description: "Hail storm dented the roof and hood while the car was parked at home.",
    },
    next("clm"),
    "PAID",
  );
  claim("clean_unusual", p, {
    ...ordinary(3),
    lossType: "hail",
    otherParty: undefined,
    impactMph: undefined,
    policeReport: false,
    description:
      "Another hail storm last night, the one on the news that hit the whole city. New dents on the roof and the hood, and the windscreen is cracked.",
  });
}
{
  // Reported twelve days late, from a hospital bed.
  const p = policyholder();
  policyLife(p);
  const c = ordinary(14);
  claim("clean_unusual", p, {
    ...c,
    reportDays: 2,
    description:
      "I was hit at an intersection on the 1st and taken to hospital with a broken wrist. I was discharged yesterday and this is the first chance I have had to report it. The police report number is on the form.",
    injuries: [{ clinic: "mercy_general_hospital", person: "driver", injury: "fractured wrist", daysAfterLoss: 0 }],
    visit: [
      [-14, "login", { entities: { device: p.device } }],
      [
        -12,
        "help_chat_message",
        { text: "I was in hospital for twelve days after an accident. Is it too late to report it?" },
      ],
      [-11, "help_chat_reply", { text: "No. Please report it now and add the police report number if you have it." }],
      [-3, "page_viewed", { page: "report a claim" }],
    ],
  });
}
{
  // A large estimate, on a car that costs a lot to repair.
  const p = { ...policyholder(), vehicle: { id: next("veh"), model: "2023 Porsche Cayenne", valueUsd: 96000 } };
  policyLife(p);
  claim("clean_unusual", p, {
    ...ordinary(2),
    estimateUsd: 14800,
    usualUsd: 13500,
    description:
      "Rear-ended on the highway in slow traffic. The rear bumper, the sensors and the tailgate are damaged. Police attended.",
  });
}

// The runner reports two claims in one visit, then two more in another, then one alone.
const runnerVisits = [next("sess"), next("sess"), next("sess")];
[300, 291, 200, 192, 100].forEach((reportMinutesAgo, i) => {
  const p = policyholder(r.int(90, 200));
  policyLife(p);
  claim("staged_accident", p, {
    ...staged(r.int(2, 6), i),
    session: runnerVisits[Math.floor(i / 2)]!,
    visit: runner(),
    reportMinutesAgo,
  });
});

for (let i = 0; i < 4; i++) {
  const p = policyholder();
  policyLife(p);
  const c = ordinary(r.int(20, 30));
  claim("inflated_claim", p, {
    ...c,
    reportDays: c.lossDays - 0.1,
    estimateUsd: Math.round(c.usualUsd * r.float(2.6, 3.4)),
    injuries: [
      { clinic: r.pick(CLINICS), person: "driver", injury: "neck and shoulder pain", daysAfterLoss: r.int(17, 22) },
    ],
    visit: [
      [-11, "login", { entities: { device: p.device } }],
      [-10, "page_viewed", { page: "what your policy pays for injuries" }],
      [-8, "page_viewed", { page: "repair and rental car limits" }],
      [-3, "page_viewed", { page: "report a claim" }],
    ],
    adjusterNote: r.pick([
      "Inspected the vehicle. Rust inside the cracked bumper and paint overspray on the quarter panel show earlier damage that is not from this collision.",
      "The estimate includes a replacement headlight and front grille; the photos of the loss show damage only to the rear.",
      "Photos from the policyholder show a dent that is also visible in the photos from the vehicle's last renewal inspection.",
    ]),
  });
}

for (let i = 0; i < 4; i++) {
  const p = {
    ...policyholder(i % 2 ? r.int(400, 900) : r.int(4, 8)),
    cover: "comprehensive" as Cover,
    priorInsurerContinuous: false,
  };
  policyLife(p);
  // The visit that bought or upgraded the cover also looked up how to claim.
  const bought = i % 2 ? at(4, 22) : at(p.policyDays, 14);
  const buying = next("sess");
  if (i % 2) {
    // An old policy, upgraded to comprehensive three days before the "loss".
    kairos.track("cover_changed", {
      policyholderId: p.id,
      from: "liability",
      to: "comprehensive",
      premium_monthly_usd: p.premium + 45,
      $session: buying,
      timestamp: bought,
    });
  }
  visit(p.id, buying, bought, [
    [-6, "login", { entities: { device: p.device } }],
    [-4, "page_viewed", { page: "what comprehensive cover pays for" }],
    [3, "page_viewed", { page: "how to make a claim" }],
    [4, "page_viewed", { page: "claims for damage when the other driver is unknown" }],
  ]);
  const lossDays = i % 2 ? 1 : p.policyDays - 2;
  const coverStarted = i % 2 ? 4 : p.policyDays;
  claim("pre_existing_loss", p, {
    lossType: "parking_lot_damage",
    lossDays,
    reportDays: lossDays - 0.05,
    description:
      "Somebody hit my car in a parking lot while I was in the store and drove off. I did not see who it was. The whole front end is damaged.",
    policeReport: false,
    shop: r.pick(SHOPS),
    estimateUsd: r.int(4200, 6800),
    usualUsd: 4600,
    photosTaken: isoDay(coverStarted + r.int(6, 20)),
    injuries: [],
    photoSource: "gallery",
    visit: [
      [-4, "login", { entities: { device: p.device } }],
      [-3, "page_viewed", { page: "report a claim" }],
    ],
  });
}

const action = await kairos.defineAction("insurance_claim", template("insurance_claim"));
console.log(`action ${action.name}@${action.version}`);
for (const { p, claim: c, id } of pending) track(p, c, id);
await kairos.flush();
for (const { id, label } of labels) await kairos.label({ type: "policyholder", id }, label);
console.log(`${serial} entities created, ${labels.length} outcome labels, ${pending.length} pending claims\n`);

const results: { kind: Kind; decision: Decision; id: string; ms: number }[] = [];
for (const { kind, p, claim: c, id } of pending) {
  const started = Date.now();
  const decision = await kairos.decide({
    type: "insurance_claim",
    entities: {
      policyholder: p.id,
      claim: id,
      repair_shop: c.shop,
      phone: p.phone,
      device: p.device,
      ...(c.otherParty ? { other_party: c.otherParty } : {}),
      ...(c.injuries[0] ? { clinic: c.injuries[0].clinic } : {}),
      ...(c.lawyer ? { lawyer: c.lawyer.id } : {}),
    },
    loss_type: c.lossType,
    claimed_usd: c.estimateUsd,
    days_since_loss: Math.round(c.lossDays),
    days_since_policy_start: p.policyDays,
    $session: c.session,
  });
  results.push({ kind, decision, id: p.id, ms: Date.now() - started });
}
await kairos.shutdown();

const KINDS: Kind[] = ["clean", "clean_unusual", "staged_accident", "inflated_claim", "pre_existing_loss"];
const EXPECTED: Record<Kind, string> = {
  clean: "legit",
  clean_unusual: "legit",
  staged_accident: "staged_accident",
  inflated_claim: "inflated_claim",
  pre_existing_loss: "pre_existing_loss",
};
const honest = (kind: Kind) => EXPECTED[kind] === "legit";
console.log("INSURANCE CLAIMS  (approve = pay automatically)");
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
console.log(`\nfraudulent claims not paid automatically: ${bad.filter(stopped).length} of ${bad.length}`);
console.log(`honest claims not paid automatically:     ${good.filter(stopped).length} of ${good.length}`);
console.log(`decide() median ${times[Math.floor(times.length / 2)]} ms, max ${times.at(-1)} ms\n`);

for (const kind of KINDS) {
  for (const { decision, id } of results.filter((x) => x.kind === kind)) {
    console.log(
      `${kind.padEnd(17)} ${id}  ${decision.decision.padEnd(7)} ${String(decision.riskScore).padStart(3)}  ${(decision.typology ?? "").padEnd(17)} ${decision.reasons.join(", ")}`,
    );
  }
}

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
