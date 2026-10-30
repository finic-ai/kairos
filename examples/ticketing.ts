/**
 * Event ticket purchases: three genuine buyers and three kinds of abuse.
 *
 *   pnpm api
 *   pnpm example:ticketing
 *
 * Set KAIROS_API_KEY in .env (console: Settings > API keys). KAIROS_URL is optional.
 * All data is synthetic. Expected outcomes stay in this script, never in the model's
 * input. New IDs isolate each run. This is a demonstration, not an accuracy benchmark.
 * Inventory, queue admission and hard purchase limits still belong in your application.
 */
import { randomUUID } from "node:crypto";
import { Kairos, type EventProperties } from "../packages/sdk/src/index.js";
import { template } from "../templates/index";

let deliveryError: Error | undefined;
const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY || missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  flushAt: 500,
  flushIntervalMs: 0,
  decideTimeoutMs: 30_000,
  onError: (error) => {
    deliveryError = error;
  },
});
const run = randomUUID();
let serial = 0;
const next = (prefix: string) => `${prefix}_${run}_${++serial}`;
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000);
const DAY = 24 * 60;
// A performance is a property, not an entity that links every fan to every other fan.
const performance = "harbour_live_friday";

interface Buyer {
  userId: string;
  deviceId: string;
  paymentMethodId: string;
}
interface Scenario {
  name: string;
  expected: "approve" | "hold";
  buyer: Buyer;
  session: string;
  request: Record<string, unknown>;
}
const buyers = (): Buyer => ({ userId: next("user"), deviceId: next("device"), paymentMethodId: next("payment") });
const scenarios: Scenario[] = [];
const labels: { userId: string; label: string }[] = [];

function account(buyer: Buyer, ageDays = 365) {
  kairos.track("account_opened", { userId: buyer.userId, timestamp: ago(ageDays * DAY) });
  if (ageDays < 30) return;
  for (const days of [90, 60, 30]) {
    const $session = next("session");
    kairos.track("login", {
      userId: buyer.userId,
      deviceId: buyer.deviceId,
      $session,
      timestamp: ago(days * DAY + 10),
    });
    kairos.track("ticket_order", {
      ...buyer,
      $session,
      universalId: next("order"),
      status: "attended",
      performance: `past_show_${days}`,
      quantity: 2,
      usd: 120,
      timestamp: ago(days * DAY),
    });
  }
}

function visit(buyer: Buyer, minutes = 12) {
  const session = next("session");
  kairos.track("login", { userId: buyer.userId, deviceId: buyer.deviceId, $session: session, timestamp: ago(minutes) });
  return session;
}

function track(buyer: Buyer, session: string, type: string, minutes: number, properties: EventProperties = {}) {
  kairos.track(type, { ...buyer, $session: session, timestamp: ago(minutes), ...properties });
}

function purchase(
  name: string,
  expected: Scenario["expected"],
  buyer: Buyer,
  session: string,
  extra: Record<string, unknown> = {},
) {
  scenarios.push({
    name,
    expected,
    buyer,
    session,
    request: { performance, quantity: 2, usd: 150, purchase_limit: 4, ...extra },
  });
}

// Returning fan: a normal browse, queue admission and seat selection.
{
  const buyer = buyers();
  account(buyer);
  const session = visit(buyer);
  track(buyer, session, "performance_viewed", 10, { performance });
  track(buyer, session, "queue_admitted", 5, { performance, server_validated: true });
  track(buyer, session, "seats_selected", 2, { performance, quantity: 2 });
  purchase("returning fan", "approve", buyer, session);
}

// Household members share a laptop, but have separate cards and ordinary past purchases.
{
  const sibling = buyers();
  account(sibling);
  const buyer = { ...buyers(), deviceId: sibling.deviceId };
  account(buyer);
  const session = visit(buyer);
  track(buyer, session, "queue_admitted", 5, { performance, server_validated: true });
  track(buyer, session, "seats_selected", 2, { performance, quantity: 4 });
  purchase("shared family laptop", "approve", buyer, session, { quantity: 4, usd: 300 });
}

// A prepared fan checks out quickly using saved details. Speed alone is not automation.
{
  const buyer = buyers();
  account(buyer);
  const session = visit(buyer, 0.5);
  track(buyer, session, "queue_admitted", 0.4, { performance, server_validated: true });
  track(buyer, session, "saved_payment_selected", 0.2);
  track(buyer, session, "browser_observed", 0.1, { automation_detected: false, webdriver: false });
  purchase("fast saved checkout", "approve", buyer, session);
}

// Newly opened accounts reserve the same inventory on one automated device.
{
  const buyer = buyers();
  account(buyer, 1);
  for (let i = 0; i < 3; i++) {
    const peer = { ...buyers(), deviceId: buyer.deviceId };
    account(peer, 2);
    for (let j = 0; j < 4; j++) {
      kairos.track("inventory_reserved", { ...peer, performance, quantity: 4, timestamp: ago(20 - i * 3 - j * 0.2) });
    }
    if (i === 0) labels.push({ userId: peer.userId, label: "automation_confirmed" });
  }
  const session = visit(buyer, 3);
  track(buyer, session, "browser_observed", 2.9, { automation_detected: true, webdriver: true });
  for (let i = 0; i < 6; i++) track(buyer, session, "inventory_reserved", 2.8 - i * 0.1, { performance, quantity: 4 });
  purchase("automated inventory hoarding", "hold", buyer, session, { quantity: 4, usd: 300 });
}

// Four tickets per buyer: two new accounts already bought four each on the same card.
{
  const buyer = buyers();
  account(buyer, 1);
  for (let i = 0; i < 2; i++) {
    const peer = { ...buyers(), paymentMethodId: buyer.paymentMethodId };
    account(peer, 1);
    kairos.track("ticket_order", {
      ...peer,
      universalId: next("order"),
      status: "completed",
      performance,
      quantity: 4,
      usd: 300,
      purchase_limit: 4,
      timestamp: ago(15 - i * 5),
    });
  }
  const session = visit(buyer, 3);
  track(buyer, session, "seats_selected", 1, { performance, quantity: 4 });
  purchase("purchases split across accounts", "hold", buyer, session, { quantity: 4, usd: 300 });
}

// An established account changes access and ticket delivery details on a new device.
{
  const owner = buyers();
  account(owner);
  const buyer = { ...owner, deviceId: next("device") };
  const session = visit(buyer, 4);
  track(buyer, session, "password_reset", 3.5);
  track(buyer, session, "contact_changed", 3, { field: "email" });
  track(buyer, session, "ticket_recipient_added", 2, { previously_used: false });
  purchase("account takeover", "hold", buyer, session, { quantity: 4, usd: 1200, delivery: "new_recipient" });
}

try {
  const action = await kairos.defineAction("ticket_purchase", template("ticket_purchase"));
  console.log(`action ${action.name}@${action.version}; run ${run}`);
  await kairos.flush();
  if (deliveryError) throw deliveryError;
  for (const { userId, label } of labels)
    await kairos.label({ type: "user", id: userId }, label, {}, { timestamp: ago(5) });

  const rows = [];
  for (const scenario of scenarios) {
    const started = Date.now();
    const decision = await kairos.decide({
      type: "ticket_purchase",
      ...scenario.buyer,
      $session: scenario.session,
      ...scenario.request,
    });
    rows.push({
      scenario: scenario.name,
      expected: scenario.expected,
      decision: decision.decision,
      risk: decision.riskScore,
      typology: decision.typology,
      reasons: decision.reasons.join(", "),
      ms: Date.now() - started,
    });
    console.log(`${scenario.name}: ${decision.decision} (${decision.riskScore}) — ${decision.reasons.join(", ")}`);
  }
  console.table(rows);
  console.log(
    "Synthetic scenarios only. Expected 'hold' includes step_up, review and block; outcomes are not guaranteed. Inspect the decisions and sessions in the console.",
  );
} finally {
  await kairos.shutdown();
}

function missingKey(): never {
  throw new Error("Set KAIROS_API_KEY in .env to a secret key from the console: Settings > API keys.");
}
