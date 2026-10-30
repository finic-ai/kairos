/**
 * Loan defaults through Kairos's MCP server, to train a decision workflow.
 *
 *   pnpm api
 *   KAIROS_API_KEY=ksk_… pnpm example:loan-experiments          # all phases
 *   KAIROS_API_KEY=ksk_… pnpm example:loan-experiments backtest # one phase
 *
 * Then design an experiment on the workflow, through MCP (create_workflow_experiment) or the API:
 * the server trains, validates and tests each variant. See docs/models/models.md#experiments.
 *
 * The key's workspace needs MCP on, with the Write, Decide and Build groups (Settings › MCP).
 * Every call goes through MCP tools, as an agent's would: save_action, save_workflow_draft,
 * publish_workflow, track_events, decide (as of each application's time) and label_entities.
 *
 * Each application has numbers that a credit model reads (score, debt-to-income, utilization,
 * inquiries, the loan against the income) and the borrower's own words: a job title and why
 * they want the money. Whether a loan is charged off depends on both. Some of the risk is only
 * in the words: a borrower in hardship, one who is vague about the money, one who will put it
 * into a bet, one whose income does not fit the job, and, the other way, one with a concrete
 * plan to repay. Tree models on the numbers cannot read words and Grayson reads them, so an
 * experiment can show how much each adds, and which combination of the two ranks the loans best.
 *
 * The loans are invented. The relation between the words and the defaults was written with
 * the generator, so the result shows that the method works, not how much it gains on real loans.
 */
import { Rng } from "../packages/eval/src/rng";

const URL = (process.env.KAIROS_URL || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.KAIROS_API_KEY ?? "";
const LOANS = Number(process.env.LOANS ?? 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const FROM = Date.parse("2025-01-01T00:00:00Z");
const TO = Date.parse("2026-03-31T00:00:00Z");
const DAY = 86_400_000;

export const ACTION = "loan_application";
export const WORKFLOW = "loan_review";

let calls = 0;
async function tool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${URL}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++calls, method: "tools/call", params: { name, arguments: args } }),
  });
  const message = (await response.json()) as any;
  if (message.error) throw new Error(`${name}: ${message.error.message}`);
  const text = message.result?.content?.[0]?.text ?? "null";
  if (message.result?.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as T;
}

const SOFTEN = ["", "", "Honestly, ", "To be clear, ", "Basically, "];

const PURPOSES = {
  debt_consolidation: [
    "I want to consolidate my credit cards into one lower monthly payment.",
    "Paying off three cards with high rates so I only have one bill.",
    "Consolidating my store cards and a personal loan.",
  ],
  home_improvement: [
    "We are replacing the roof on our house before winter.",
    "Kitchen renovation, mostly cabinets and new appliances.",
    "Fixing the basement after water damage the insurance didn't cover fully.",
  ],
  car: ["Buying a used car to get to work.", "My car needs a new transmission.", "Down payment on a reliable car."],
  medical: ["Covering a planned surgery and the deductible.", "Dental work that insurance doesn't cover."],
  major_purchase: ["New furniture for our first apartment.", "Buying equipment for my home office."],
  small_business: [
    "Expanding the inventory of the shop I've run for six years.",
    "Buying a second truck for my landscaping company.",
  ],
} as const;
type Purpose = keyof typeof PURPOSES;

const HARDSHIP = [
  "I was laid off two months ago and I'm behind on rent, this would help me catch up.",
  "My hours got cut and I've been using the cards to cover groceries.",
  "Since my divorce I've been struggling to keep up with everything.",
  "We had a death in the family and the funeral costs put us behind on bills.",
  "I've had to skip a couple of payments recently because of medical bills.",
];
const PLAN = [
  "My payment will drop from $640 to $410 a month, and I set up autopay from my paycheck.",
  "I've budgeted the payment and will close the cards once they're paid off.",
  "I got a raise in March and the new payment fits easily in my budget.",
  "I have six months of savings and I'll pay this off early with my annual bonus.",
];
const EVASIVE = [
  "Just need the money for some things.",
  "Personal reasons, I'd rather not get into it.",
  "Various expenses.",
  "It's complicated but I'll be fine.",
];
const RISKY = [
  "I have a sure thing on a crypto token that's about to take off and I'll pay it back from that.",
  "Going to use part of it in Vegas, I've been on a winning streak.",
  "Investing in my friend's startup, he says it'll triple in a year.",
];
const STEADY_JOBS = [
  ["Registered Nurse", 72_000],
  ["Senior Software Engineer", 145_000],
  ["Teacher", 54_000],
  ["Electrician", 66_000],
  ["Accountant", 70_000],
  ["Police Officer", 68_000],
  ["Pharmacist", 125_000],
  ["Project Manager", 95_000],
] as const;
const MODEST_JOBS = [
  ["Cashier", 28_000],
  ["Server", 31_000],
  ["Warehouse Associate", 35_000],
  ["Barista", 26_000],
  ["Delivery Driver", 38_000],
] as const;
const VAGUE_JOBS = ["Self", "Business", "Owner", "Manager", "Consultant", "n/a"];

export interface Application {
  id: string;
  ts: string;
  properties: Record<string, string | number>;
  defaulted: boolean;
  chargedOffAt?: string;
}

export function generate(count: number, seed = 20261030): Application[] {
  const rng = new Rng(seed);
  const normal = () => {
    const u = Math.max(rng.next(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const out: Application[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(FROM + Math.floor(rng.next() * (TO - FROM)));
    const purpose = rng.weighted(Object.keys(PURPOSES) as Purpose[], [45, 15, 12, 8, 10, 10]);
    const creditScore = Math.round(clamp(700 + 45 * normal(), 580, 830));
    const hardship = rng.chance(0.16);
    const plan = !hardship && rng.chance(0.3);
    const evasive = !plan && rng.chance(0.1);
    const risky = rng.chance(0.06);
    const inflated = rng.chance(0.1);

    const steady = rng.chance(0.7);
    const [title, pay] = steady ? rng.pick(STEADY_JOBS) : rng.pick(MODEST_JOBS);
    const jobTitle = inflated && rng.chance(0.5) ? rng.pick(VAGUE_JOBS) : title;
    // An inflated income is a modest job's title with a stated income several times its pay.
    const income = Math.round(
      (inflated ? (MODEST_JOBS[rng.int(0, MODEST_JOBS.length - 1)]![1] as number) * rng.float(3, 5) : pay) *
        rng.float(0.85, 1.25),
    );
    const statedTitle = inflated && jobTitle === title ? rng.pick(MODEST_JOBS)[0] : jobTitle;
    const amount = Math.round(clamp(income * rng.float(0.05, 0.45), 1000, 40000) / 250) * 250;
    const dti = Math.round(clamp(18 + 8 * normal() + (hardship ? 4 : 0), 1, 45) * 10) / 10;
    const revolUtil = Math.round(clamp(45 + 22 * normal() + (hardship ? 10 : 0), 0, 100));
    const inquiries = Math.min(8, Math.floor(-Math.log(Math.max(rng.next(), 1e-9)) * 1.1));
    const delinquencies = rng.chance(0.12) ? rng.int(1, 3) : 0;
    const term = rng.chance(0.3) ? 60 : 36;
    const empLength = rng.int(0, 10);
    const rate =
      Math.round(clamp(6 + (760 - creditScore) * 0.09 + (term === 60 ? 2 : 0) + normal(), 5.5, 30) * 100) / 100;

    const lead = rng.pick(SOFTEN);
    const reason = rng.pick(PURPOSES[purpose]);
    const sentences = [lead ? lead + reason[0]!.toLowerCase() + reason.slice(1) : reason];
    if (hardship) sentences.push(rng.pick(HARDSHIP));
    if (plan) sentences.push(rng.pick(PLAN));
    if (risky) sentences.push(rng.pick(RISKY));
    const description = evasive ? rng.pick(EVASIVE) : sentences.join(" ");

    const z =
      -2.6 +
      -0.022 * (creditScore - 700) +
      0.045 * (dti - 18) +
      0.012 * (revolUtil - 45) +
      0.2 * inquiries +
      0.4 * delinquencies +
      (term === 60 ? 0.35 : 0) +
      1.6 * (amount / income - 0.22) -
      0.04 * empLength +
      (hardship ? 1.5 : 0) +
      (plan ? -0.9 : 0) +
      (evasive ? 1.0 : 0) +
      (risky ? 1.4 : 0) +
      (inflated ? 1.0 : 0);
    const defaulted = rng.chance(1 / (1 + Math.exp(-z)));
    out.push({
      id: `app_${String(i + 1).padStart(5, "0")}`,
      ts: ts.toISOString(),
      properties: {
        amount,
        term_months: term,
        interest_rate: rate,
        annual_income: income,
        dti,
        credit_score: creditScore,
        revol_util: revolUtil,
        inquiries_6m: inquiries,
        delinquencies_2y: delinquencies,
        emp_length_years: empLength,
        purpose,
        job_title: statedTitle,
        description,
      },
      defaulted,
      ...(defaulted ? { chargedOffAt: new Date(ts.getTime() + rng.int(30, 170) * DAY).toISOString() } : {}),
    });
  }
  return out;
}

const QUESTIONS = {
  hardship: { type: "yes_no", question: "Does the borrower describe current financial hardship?" },
  repayment_plan: {
    type: "yes_no",
    question: "Does the description lay out a specific, credible plan for repaying the loan?",
  },
  evasive: {
    type: "yes_no",
    question: "Is the description evasive, or vague about what the money is for?",
  },
  risky_use: {
    type: "yes_no",
    question: "Will the money go into gambling, speculation or a risky venture?",
  },
  income_plausible: {
    type: "yes_no",
    question: "Is the stated annual income plausible for this job title?",
  },
  underwriter_concern: {
    type: "yes_no",
    question: "Would an experienced underwriter have concerns about this application?",
  },
};

export const WORKFLOW_STEPS = [
  {
    id: "ask",
    name: "Read the application",
    type: "ask",
    data: {
      job_title: "{{ trigger.properties.job_title }}",
      annual_income: "{{ trigger.properties.annual_income }}",
      purpose: "{{ trigger.properties.purpose }}",
      amount: "{{ trigger.properties.amount }}",
      term_months: "{{ trigger.properties.term_months }}",
      description: "{{ trigger.properties.description }}",
    },
    questions: QUESTIONS,
  },
  {
    id: "answer",
    name: "Approve",
    type: "answer",
    value: { outcome: "approve", probability: "{{ steps.ask.output.underwriter_concern.probability }}" },
  },
];

async function setup() {
  await tool("save_action", {
    name: ACTION,
    definition: { subject: "applicant", hold: "Should this loan application be held for review?" },
  });
  await tool("save_workflow_draft", {
    name: WORKFLOW,
    display_name: "Loan review",
    trigger: { type: "decision", action: ACTION },
    steps: WORKFLOW_STEPS,
  });
  const published = await tool("publish_workflow", { name: WORKFLOW });
  console.log(`Workflow ${WORKFLOW} published: version ${published.version}.`);
}

async function history(apps: Application[]) {
  for (let i = 0; i < apps.length; i += 100) {
    await tool("track_events", {
      events: apps.slice(i, i + 100).map((a) => ({
        id: `evt_${a.id}`,
        type: "loan_application",
        ts: a.ts,
        entities: { applicant: a.id },
        properties: a.properties,
      })),
    });
  }
  console.log(`${apps.length} applications sent.`);
}

async function backtest(apps: Application[]) {
  let next = 0;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (next < apps.length) {
      const a = apps[next++]!;
      for (let attempt = 1; ; attempt++) {
        try {
          await tool("decide", { action: ACTION, entities: { applicant: a.id }, properties: a.properties, ts: a.ts });
          break;
        } catch (error) {
          if (attempt >= 3) {
            failed++;
            console.error(`${a.id}: ${(error as Error).message.slice(0, 200)}`);
            break;
          }
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      if (++done % 100 === 0) console.log(`${done} of ${apps.length} decided as of their time…`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`${done - failed} decisions made as of each application's time, ${failed} failed.`);
}

async function labels(apps: Application[]) {
  const charged = apps.filter((a) => a.defaulted);
  for (let i = 0; i < charged.length; i += 100) {
    await tool("label_entities", {
      labels: charged.slice(i, i + 100).map((a) => ({
        entity: { type: "applicant", id: a.id },
        label: "charged_off",
        ts: a.chargedOffAt,
      })),
    });
  }
  console.log(`${charged.length} of ${apps.length} loans labelled charged_off.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!KEY) {
    console.error("Set KAIROS_API_KEY to a secret key of a workspace with MCP on (Write, Decide and Build).");
    process.exit(2);
  }
  const phase = process.argv[2] ?? "all";
  const apps = generate(LOANS);
  if (phase === "all" || phase === "setup") await setup();
  if (phase === "all" || phase === "history") await history(apps);
  if (phase === "all" || phase === "backtest") await backtest(apps);
  if (phase === "all" || phase === "labels") await labels(apps);
}
