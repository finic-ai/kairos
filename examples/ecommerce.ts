/**
 * Ecommerce checkout: three genuine purchases and three fraud scenarios.
 *
 *   pnpm api
 *   pnpm example:ecommerce
 *
 * Set KAIROS_API_KEY in .env (console: Settings > API keys). KAIROS_URL is optional.
 * All data is synthetic; payment and address IDs stand for opaque tokens, not card
 * numbers or raw addresses. Each run has fresh IDs. Expected outcomes are printed
 * locally, never sent to Kairos. This does not measure real-world accuracy.
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

interface Shopper {
  userId: string;
  deviceId: string;
  paymentMethodId: string;
  deliveryAddressId: string;
}
interface Scenario {
  name: string;
  expected: "approve" | "hold";
  shopper: Shopper;
  session: string;
  request: Record<string, unknown>;
}
const shoppers = (): Shopper => ({
  userId: next("user"),
  deviceId: next("device"),
  paymentMethodId: next("payment"),
  deliveryAddressId: next("address"),
});
const scenarios: Scenario[] = [];
const labels: { userId: string; label: string }[] = [];

function account(shopper: Shopper, ageDays = 365) {
  kairos.track("account_opened", { userId: shopper.userId, timestamp: ago(ageDays * DAY) });
  if (ageDays < 30) return;
  for (const days of [90, 60, 30]) {
    const $session = next("session");
    kairos.track("login", {
      userId: shopper.userId,
      deviceId: shopper.deviceId,
      $session,
      timestamp: ago(days * DAY + 10),
    });
    kairos.track("shop_order", {
      ...shopper,
      $session,
      universalId: next("order"),
      status: "delivered",
      usd: 65,
      category: "homeware",
      timestamp: ago(days * DAY),
    });
  }
}

function visit(shopper: Shopper, minutes = 12) {
  const session = next("session");
  kairos.track("login", {
    userId: shopper.userId,
    deviceId: shopper.deviceId,
    $session: session,
    timestamp: ago(minutes),
  });
  return session;
}

function track(shopper: Shopper, session: string, type: string, minutes: number, properties: EventProperties = {}) {
  kairos.track(type, { ...shopper, $session: session, timestamp: ago(minutes), ...properties });
}

function checkout(
  name: string,
  expected: Scenario["expected"],
  shopper: Shopper,
  session: string,
  extra: Record<string, unknown> = {},
) {
  scenarios.push({
    name,
    expected,
    shopper,
    session,
    request: { usd: 85, category: "homeware", quantity: 2, shipping: "standard", ...extra },
  });
}

// A returning customer browses and buys on their usual device, card and address.
{
  const shopper = shoppers();
  account(shopper);
  const session = visit(shopper);
  track(shopper, session, "product_viewed", 10, { sku: "ceramic-mug" });
  track(shopper, session, "cart_updated", 5, { quantity: 2 });
  track(shopper, session, "payment_verified", 1, {
    security_code: "match",
    billing_address: "match",
    three_ds: "authenticated",
  });
  checkout("returning customer", "approve", shopper, session);
}

// A delivery address differs from billing for a gift, with successful authentication.
{
  const owner = shoppers();
  account(owner);
  const shopper = { ...owner, deliveryAddressId: next("address") };
  const session = visit(shopper);
  track(shopper, session, "gift_options_selected", 8, { gift_wrap: true, message_added: true });
  track(shopper, session, "delivery_address_added", 5, { same_as_billing: false });
  track(shopper, session, "payment_verified", 1, {
    security_code: "match",
    billing_address: "match",
    three_ds: "authenticated",
  });
  checkout("gift to a new address", "approve", shopper, session, { gift: true });
}

// Shared home and tablet, separate payment methods, and a single recoverable decline.
{
  const partner = shoppers();
  account(partner);
  const shopper = { ...shoppers(), deviceId: partner.deviceId, deliveryAddressId: partner.deliveryAddressId };
  account(shopper);
  const session = visit(shopper);
  track(shopper, session, "payment_attempt", 4, {
    universalId: next("attempt"),
    status: "declined",
    usd: 85,
    decline_reason: "authentication_required",
  });
  track(shopper, session, "payment_verified", 1, {
    security_code: "match",
    billing_address: "match",
    three_ds: "authenticated",
  });
  checkout("household, one payment retry", "approve", shopper, session);
}

// Eight distinct cards fail within a short visit before one more payment is requested.
{
  const shopper = shoppers();
  account(shopper, 1);
  const session = visit(shopper, 3);
  for (let i = 0; i < 8; i++) {
    track(shopper, session, "payment_attempt", 2.8 - i * 0.25, {
      paymentMethodId: next("payment"),
      universalId: next("attempt"),
      status: "declined",
      usd: 1,
      decline_reason: i % 2 ? "security_code_mismatch" : "do_not_honor",
    });
  }
  checkout("card testing", "hold", shopper, session, { usd: 1, category: "digital_download", quantity: 1 });
}

// A new account reuses both the payment token and destination of confirmed fraud.
{
  const peer = shoppers();
  account(peer, 20);
  kairos.track("shop_order", {
    ...peer,
    universalId: next("order"),
    status: "chargeback",
    usd: 1800,
    category: "electronics",
    chargeback_reason: "unauthorised_payment",
    timestamp: ago(7 * DAY),
  });
  labels.push({ userId: peer.userId, label: "fraud_confirmed" });
  const shopper = { ...shoppers(), paymentMethodId: peer.paymentMethodId, deliveryAddressId: peer.deliveryAddressId };
  account(shopper, 1);
  const session = visit(shopper, 4);
  track(shopper, session, "payment_verified", 1, {
    security_code: "mismatch",
    billing_address: "mismatch",
    three_ds: "failed",
  });
  checkout("linked stolen payment", "hold", shopper, session, {
    usd: 2200,
    category: "electronics",
    shipping: "overnight",
  });
}

// Saved payment details on an established account, but new access and delivery details.
{
  const owner = shoppers();
  account(owner);
  const shopper = { ...owner, deviceId: next("device"), deliveryAddressId: next("address") };
  const session = visit(shopper, 4);
  track(shopper, session, "password_reset", 3.5);
  track(shopper, session, "contact_changed", 3, { field: "email" });
  track(shopper, session, "delivery_address_added", 2, { same_as_billing: false });
  track(shopper, session, "cart_updated", 1, { category: "electronics", quantity: 3 });
  checkout("account takeover", "hold", shopper, session, {
    usd: 2850,
    category: "electronics",
    quantity: 3,
    shipping: "overnight",
  });
}

try {
  const action = await kairos.defineAction("ecommerce_checkout", template("ecommerce_checkout"));
  console.log(`action ${action.name}@${action.version}; run ${run}`);
  await kairos.flush();
  if (deliveryError) throw deliveryError;
  for (const { userId, label } of labels)
    await kairos.label({ type: "user", id: userId }, label, {}, { timestamp: ago(DAY) });

  const rows = [];
  for (const scenario of scenarios) {
    const started = Date.now();
    const decision = await kairos.decide({
      type: "ecommerce_checkout",
      ...scenario.shopper,
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
