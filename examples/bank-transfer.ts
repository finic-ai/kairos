/**
 * The fraud example from the product page, end to end against a local server.
 *
 *   GRAYSON_API_KEY=... pnpm api         with KAIROS_API_KEY in .env: a secret key from the console (Settings › API keys)
 *   pnpm example
 *
 * Nothing here is built into Kairos: the event types, the entities and the action are
 * all defined by this script.
 */
import { Kairos } from "../packages/sdk/src/index.js";
import { template } from "../templates/index";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY ?? missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  decideTimeoutMs: 15_000,
  onError: (error) => console.error("delivery failed:", error.message),
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const DAY = 24 * 60;

// 1. Define the action once. Plain language in, no rules engine, no feature code.
const action = await kairos.defineAction("bank_transfer", template("bank_transfer"));
console.log(`action ${action.name}@${action.version}`);

// 2. An established customer: two years of salary, card spend and rent to the same landlord.
await kairos.setObject("user", "user_alice", { kyc_country: "GB", plan: "standard" });
for (let month = 24; month >= 1; month--) {
  const t = month * 30 * DAY;
  kairos.track("login", { userId: "user_alice", deviceId: "dev_alice_phone", ipCountry: "GB", timestamp: ago(t) });
  kairos.track("salary_received", { userId: "user_alice", amount: 3200, currency: "GBP", timestamp: ago(t - 5) });
  kairos.track("bank_transfer", {
    userId: "user_alice",
    beneficiaryId: "ben_landlord",
    amount: 1100,
    currency: "GBP",
    timestamp: ago(t - 60),
  });
  kairos.track("card_payment", {
    userId: "user_alice",
    amount: 40 + month,
    currency: "GBP",
    merchantCategory: "groceries",
    timestamp: ago(t - 2 * DAY),
  });
}
kairos.track("login", { userId: "user_alice", deviceId: "dev_alice_phone", ipCountry: "GB", timestamp: ago(3) });

// 3. A ring: seven accounts opened on one device, two already confirmed as fraud.
for (let i = 1; i <= 7; i++) {
  kairos.track("account_opened", { userId: `user_ring_${i}`, deviceId: "dev_shared", timestamp: ago((10 + i) * DAY) });
}
await kairos.flush();
await kairos.label({ type: "user", id: "user_ring_1" }, "fraud_confirmed");
await kairos.label({ type: "user", id: "user_ring_2" }, "fraud_confirmed");

// 4. The account from the product page: two days old, same device, $40k through in an hour.
kairos.track("account_opened", { userId: "user_bob", deviceId: "dev_shared", timestamp: ago(2 * DAY) });
kairos.track("kyc_completed", { userId: "user_bob", timestamp: ago(2 * DAY - 10) });
for (const [i, amount] of [9800, 9900, 9700, 9600].entries()) {
  kairos.track("deposit_received", {
    userId: "user_bob",
    amount,
    currency: "USD",
    senderId: `sender_${i}`,
    timestamp: ago(58 - i * 8),
  });
  kairos.track("bank_transfer", {
    userId: "user_bob",
    beneficiaryId: "ben_new",
    amount: amount - 300,
    currency: "USD",
    timestamp: ago(54 - i * 8),
  });
}
kairos.track("login", { userId: "user_bob", deviceId: "dev_shared", ipCountry: "GB", timestamp: ago(4) });
kairos.track("beneficiary_added", { userId: "user_bob", beneficiaryId: "ben_other", timestamp: ago(3) });

// 5. Decide. The request is one event: trackAndDecide stores it and returns the decision.
//    It sends the queued events first, so the decision sees everything above.
for (const [label, request] of [
  [
    "established customer, usual rent",
    { userId: "user_alice", beneficiaryId: "ben_landlord", deviceId: "dev_alice_phone", amount: 1100, currency: "GBP" },
  ],
  [
    "two-day-old account, new beneficiary",
    { userId: "user_bob", beneficiaryId: "ben_other", deviceId: "dev_shared", amount: 9500, currency: "USD" },
  ],
] as const) {
  const started = Date.now();
  const { error, ...decision } = await kairos.trackAndDecide("bank_transfer_requested", request);
  console.log(`\n${label}  (${Date.now() - started} ms)`);
  console.log(JSON.stringify(decision, null, 2));
}

await kairos.shutdown();

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
