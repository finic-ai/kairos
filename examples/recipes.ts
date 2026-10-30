/**
 * Two Grayson recipes from https://docs.finic.ai/recipes, run through Kairos.
 *
 *   GRAYSON_API_KEY=... pnpm api         with KAIROS_API_KEY in .env: a secret key from the console (Settings › API keys)
 *   pnpm example:recipes
 *
 * A recipe is one Grayson request: a hand-built context and typed questions. Here the same
 * data goes in as Kairos entities and events, the questions become an action, and Kairos
 * builds the context itself. The result is set beside the answer the recipe page publishes.
 *
 * Each recipe runs two times: with the default of 30 recent events in full, and with the
 * whole history in full, which is what the recipe sends. Every run uses new entity ids.
 */
import { Kairos } from "../packages/sdk/src/index.js";

const baseUrl = process.env.KAIROS_URL || "http://localhost:8787";
const apiKey = process.env.KAIROS_API_KEY ?? missingKey();
const kairos = new Kairos({
  apiKey,
  baseUrl,
  decideTimeoutMs: 60_000,
  onError: (error) => console.error("delivery failed:", error.message),
});

const DOCS = "https://docs.finic.ai/recipes";
const run = Date.now().toString(36);
const EXAMPLES = ["fraud", "legitimate", "ambiguous"] as const;
const VARIANTS = [
  { suffix: "", label: "30 recent", recentEvents: 30 },
  { suffix: "_full", label: "all in full", recentEvents: 500 },
];

type Json = Record<string, any>;
interface Table {
  columns: string[];
  rows: unknown[][];
}

const load = async (path: string): Promise<Json> => {
  const response = await fetch(`${DOCS}/${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as Json;
};
/** The rows of a recipe table as objects, without empty cells. */
const records = (table: Table): Json[] =>
  table.rows.map((row) =>
    Object.fromEntries(table.columns.map((c, i) => [c, row[i]] as const).filter(([, v]) => v !== "" && v !== null)),
  );
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const later = (ts: string, minutes = 1) => new Date(new Date(ts).getTime() + minutes * 60_000);

interface Row {
  recipe: string;
  example: string;
  context: string;
  published: string;
  hold: string;
  other: string;
  outcome: string;
  tokens: number;
}
const rows: Row[] = [];
const pct = (p: number | undefined) => (p === undefined ? "-" : `${Math.round(p * 100)}%`);

/** The decision log has what the SDK result leaves out: every probability and the size of the context. */
async function log(decisionId: string): Promise<Json> {
  const response = await fetch(`${baseUrl}/v1/decisions/${decisionId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return (await response.json()) as Json;
}

// Card authorization. Recipe questions: fraud_likelihood (score), card_tested (yes/no), action (choice).
// In Kairos: the hold question is the fraud question, card_tested is a reason, and the policy picks the outcome.
const cardQuestions = await load("card-authorization-fraud/questions.json");
for (const v of VARIANTS) {
  await kairos.defineAction(`recipe_card_auth${v.suffix}`, {
    description: `Recipe: card authorization fraud (${v.label})`,
    subject: "user",
    hold: "Should the authorization under review be held because it is fraudulent, meaning the cardholder didn't make it?",
    // An action needs two reasons or more. The second one is not from the recipe.
    reasons: {
      card_tested: cardQuestions.card_tested.instructions,
      unusual_for_cardholder:
        "The purchase is unlike the cardholder's usual spending in amount, merchant type, channel or place",
    },
    context: { recentEvents: v.recentEvents },
  });
}
const CARD_PUBLISHED = {
  fraud: "fraud very likely; card_tested 98%; decline",
  legitimate: "fraud very unlikely; card_tested 3%; approve",
  ambiguous: "fraud spread, 66% likely or more; card_tested 13%; step_up",
};

for (const example of EXAMPLES) {
  const c = (await load(`card-authorization-fraud/${example}.json`)).context;
  const userId = `${c.cardholder.account_id}_${run}`;
  const activity = Object.entries(c.merchant_activity_on_our_cards as Json);
  /** One id for a merchant, so that what the issuer knows about it joins the events that name it. */
  const merchantId = (name: string) => `${slug(activity.find(([key]) => name.startsWith(key))?.[0] ?? name)}_${run}`;

  await kairos.setObject("user", userId, {
    ...c.cardholder,
    devices: c.devices,
    spend_profile_12_months: c.spend_profile_12_months,
    ...(c.compromise_alerts ? { compromise_alerts: c.compromise_alerts } : {}),
    how_to_read_authorizations: { checks: c.legend.checks, amount_usd: c.legend.amount_usd, entry: c.legend.entry },
  });
  for (const [name, about] of activity)
    await kairos.setObject(
      "merchant",
      merchantId(name),
      typeof about === "string" ? { summary: about } : (about as Json),
    );

  for (const { ts, merchant, mcc, ...rest } of records(c.authorization_history)) {
    kairos.track("card_authorization", {
      userId,
      merchantId: merchantId(merchant),
      category: `${mcc} ${c.legend.mcc[mcc] ?? ""}`.trim(),
      ...rest,
      timestamp: ts,
    });
  }
  for (const { ts, ...rest } of records(c.account_events_90_days))
    kairos.track("account_event", { userId, ...rest, timestamp: ts });
  for (const { ts, merchant, ...rest } of records(c.three_d_secure_history_90_days)) {
    kairos.track("three_d_secure_check", { userId, merchantId: merchantId(merchant), ...rest, timestamp: ts });
  }

  const { ts, merchant, ...review } = c.authorization_under_review;
  for (const v of VARIANTS) {
    const d = await kairos.decide(
      { type: `recipe_card_auth${v.suffix}`, userId, merchantId: merchantId(merchant), ...review },
      { timestamp: ts },
    );
    const detail = await log(d.decisionId!);
    rows.push({
      recipe: "card authorization",
      example,
      context: v.label,
      published: CARD_PUBLISHED[example],
      hold: pct(d.probability),
      other: `card_tested ${pct(detail.raw.answers.reasons?.probabilities.card_tested)}`,
      outcome: d.decision,
      tokens: detail.raw.usage.input_tokens,
    });
  }
}

// Money mule. Recipe questions: is_mule (yes/no), holder_role (choice), fraud_proceeds (score), action (choice).
// In Kairos: is_mule is the hold question and holder_role is the typology. The score has no place.
const muleQuestions = await load("money-mule-detection/questions.json");
for (const v of VARIANTS) {
  await kairos.defineAction(`recipe_mule_review${v.suffix}`, {
    description: `Recipe: money mule detection (${v.label})`,
    subject: "user",
    hold: `Should this account be restricted? Answer yes if this is true: ${muleQuestions.is_mule.instructions}`,
    typologies: muleQuestions.holder_role.options,
    context: { recentEvents: v.recentEvents },
  });
}
const MULE_PUBLISHED = {
  fraud: "is_mule 90%; unwitting; close_and_refer",
  legitimate: "is_mule 1%; no_mule_activity; monitor",
  ambiguous: "is_mule 35%; no_mule_activity; close_and_refer",
};

for (const example of EXAMPLES) {
  const c = (await load(`money-mule-detection/${example}.json`)).context;
  const userId = `${c.customer.customer_id}_${run}`;
  const payeeId = (id: string) => `${userId}_${id}`;
  const { session_events, ...devices } = c.devices_and_logins;

  await kairos.setObject("user", userId, {
    ...c.customer,
    accounts: c.accounts,
    devices_and_logins: devices,
    links_to_other_customers: c.links_to_other_customers,
  });
  // What the bank knows about each counterparty. Its totals are left out: they come from the transactions.
  for (const { id, name, kind, institution, first_activity, notes } of records(c.counterparties)) {
    await kairos.setObject("payee", payeeId(id), {
      name,
      kind,
      institution,
      first_activity,
      ...(notes ? { notes } : {}),
    });
  }

  let last = c.alert.created as string;
  const track = (type: string, ts: string, properties: Json) => {
    if (ts > last) last = ts;
    kairos.track(type, { userId, ...properties, timestamp: ts });
  };
  // The recipe gives 13 months as a table. Kairos has no table, so each month is an event at its end.
  for (const { month, ...rest } of records(c.monthly_summary)) {
    const [year, m] = (month as string).slice(0, 7).split("-").map(Number) as [number, number];
    const end = new Date(Date.UTC(year, m, 1) - 1000).toISOString();
    if (end < c.alert.created) track("monthly_statement", end, { month, ...rest });
  }
  for (const { ts, type, counterparty, ...rest } of records(c.transactions)) {
    track("transaction", ts, { kind: type, ...(counterparty ? { payeeId: payeeId(counterparty) } : {}), ...rest });
  }
  for (const e of session_events as Json[]) track("session_event", e.ts, { event: e.event });
  for (const { received, type, ...rest } of c.reports_from_other_institutions as Json[])
    track("report_from_other_institution", received, { report_type: type, ...rest });
  for (const { ts, ...rest } of c.customer_contact as Json[]) track("customer_contact", ts, rest);
  for (const { ts, ...rest } of c.case_notes as Json[]) track("case_note", ts, rest);

  for (const v of VARIANTS) {
    const d = await kairos.decide(
      { type: `recipe_mule_review${v.suffix}`, userId, ...c.alert },
      { timestamp: later(last) },
    );
    const detail = await log(d.decisionId!);
    rows.push({
      recipe: "money mule",
      example,
      context: v.label,
      published: MULE_PUBLISHED[example],
      hold: pct(d.probability),
      other: `${d.typology} ${pct(detail.raw.answers.typology?.probabilities[d.typology ?? ""])}`,
      outcome: d.decision,
      tokens: detail.raw.usage.input_tokens,
    });
  }
}

await kairos.shutdown();
console.table(rows);

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
