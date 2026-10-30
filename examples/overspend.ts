/**
 * Can Kairos stop a customer who spends more than they have?
 *
 *   GRAYSON_API_KEY=... pnpm api         with KAIROS_API_KEY in .env: a secret key from the console (Settings › API keys)
 *   pnpm example:overspend
 *
 * Each scenario funds a wallet, then asks for payments. A payment is one record: it is sent as
 * "pending" for the decision and then settled as "completed" or "declined", so the next decision
 * sees what happened to it. Every run uses new user ids, so a second run starts clean.
 */
import { Kairos } from "../packages/sdk/src/index.js";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY ?? missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  decideTimeoutMs: 30_000,
  onError: (error) => console.error("delivery failed:", error.message),
});

const run = Date.now().toString(36);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const DAY = 24 * 60;

const action = await kairos.defineAction("wallet_spend", {
  description: "Payment out of a wallet balance",
  subject: "user",
  trigger: { event: "wallet_transaction", status: "pending" },
  hold:
    "Should the pending payment be held because the wallet does not have enough money for it, or because the customer tries to spend the same money more than once? " +
    "The money available is the completed money in, minus the completed money out, minus the other payments out that are still pending.",
  typologies: {
    overspend: "The payment is more than the money that is available in the wallet",
    double_spend:
      "The same money is spent two times: another payment that uses the same funds is pending or was made moments before",
    legit: "The wallet has enough money for the payment",
  },
  reasons: {
    insufficient_funds: "The amount of the pending payment is more than the money available in the wallet",
    rapid_spending: "Many payments were requested in a very short time",
    concurrent_payment: "Another payment out of the same wallet is still pending",
  },
  policy: { block: 0.9, review: 0.5, rules: [{ id: "no_funds", allOf: ["insufficient_funds"], outcome: "block" }] },
  context: { recentEvents: 30 },
});
console.log(`action ${action.name}@${action.version}\n`);

let txn = 0;
const nextId = () => `txn_${run}_${++txn}`;

function deposit(userId: string, amount: number, timestamp = ago(60)) {
  kairos.track("wallet_transaction", {
    userId,
    universalId: nextId(),
    status: "completed",
    direction: "in",
    amount,
    currency: "USD",
    timestamp,
  });
}

interface Row {
  scenario: string;
  payment: string;
  balance: number;
  correct: "approve" | "hold";
  decision: string;
  risk: number;
  reasons: string;
  ms: number;
}
const rows: Row[] = [];

/** `balance` is what the wallet really holds; Kairos is not told it unless `extra` carries it. */
async function spend(
  scenario: string,
  userId: string,
  amount: number,
  balance: number,
  extra: Record<string, unknown> = {},
  settle = true,
) {
  const universalId = nextId();
  const started = Date.now();
  const d = await kairos.trackAndDecide("wallet_transaction", {
    userId,
    merchantId: `merchant_${run}_${txn}`,
    universalId,
    status: "pending",
    direction: "out",
    amount,
    currency: "USD",
    ...extra,
  });
  const approved = d.decision === "approve";
  if (settle) {
    kairos.track("wallet_transaction", { userId, universalId, status: approved ? "completed" : "declined" });
    await kairos.flush();
  }
  rows.push({
    scenario,
    payment: `$${amount}`,
    balance,
    correct: amount <= balance ? "approve" : "hold",
    decision: d.decision,
    risk: d.riskScore,
    reasons: (d.reasons ?? []).join(", "),
    ms: Date.now() - started,
  });
  return approved;
}

/** The balance goes down only when Kairos approves, as it would in a real wallet. */
async function sequence(
  scenario: string,
  userId: string,
  funded: number,
  amounts: number[],
  extra?: (balance: number) => Record<string, unknown>,
) {
  let balance = funded;
  for (const amount of amounts) {
    if (await spend(scenario, userId, amount, balance, extra?.(balance))) balance -= amount;
  }
  return balance;
}

// 0. Control: a wallet with plenty of money. Nothing here should be held.
deposit(`user_ctl_${run}`, 1000);
await sequence("0 control, $1000 in", `user_ctl_${run}`, 1000, [60, 60]);

// 1. $100 in, then $60, $60, $40. The second $60 is more than what is left; the $40 is exactly what is left.
deposit(`user_seq_${run}`, 100);
await sequence("1 $100 in, spend in turn", `user_seq_${run}`, 100, [60, 60, 40]);

// 2. $100 in, one payment of $150.
deposit(`user_big_${run}`, 100);
await sequence("2 $100 in, one large", `user_big_${run}`, 100, [150]);

// 3. Rapid spending: $100 in, six payments of $25 as fast as they can be sent. Four fit.
deposit(`user_fast_${run}`, 100);
await sequence("3 $100 in, rapid $25s", `user_fast_${run}`, 100, [25, 25, 25, 25, 25, 25]);

// 4. The race: $100 in, two payments of $100 sent at the same moment. Only one can be right.
deposit(`user_race_${run}`, 100);
await kairos.flush();
await Promise.all([
  spend("4 $100 in, two at once", `user_race_${run}`, 100, 100, {}, false),
  spend("4 $100 in, two at once", `user_race_${run}`, 100, 100, {}, false),
]);
// Exactly one of the two can be paid. If one was approved, a hold on the other is the correct answer.
const race = rows.slice(-2);
const loser = race.find((r) => r.decision !== "approve") ?? race[1]!;
if (race.some((r) => r.decision === "approve")) loser.correct = "hold";

// 5. A long history. 20 deposits and 45 payments leave $100, but only the last 30 events are sent
//    in full; the older ones are a summary with a count, a median and a maximum, not a sum.
const long = async (userId: string) => {
  const deposits = [310, 680, 450, 520, 700, 390, 610, 480, 530, 420, 660, 350, 590, 470, 640, 380, 560, 440, 620, 500]; // 10 300
  deposits.forEach((amount, i) => deposit(userId, amount, ago((90 - i) * DAY)));
  for (let i = 0; i < 45; i++) {
    const amount = i < 44 ? 230 : 80; // 44 × 230 + 80 = 10 200
    kairos.track("wallet_transaction", {
      userId,
      merchantId: `merchant_${i % 6}`,
      universalId: nextId(),
      status: "completed",
      direction: "out",
      amount,
      currency: "USD",
      timestamp: ago((60 - i) * DAY),
    });
  }
  await kairos.flush();
};
await long(`user_long_${run}`);
await sequence("5 long history, $100 left", `user_long_${run}`, 100, [230]);

// 6. The same history, and the request carries the balance from the ledger.
await long(`user_bal_${run}`);
await sequence("6 same, balance sent", `user_bal_${run}`, 100, [230, 90], (balance) => ({ balance_before: balance }));

await kairos.shutdown();

const held = (r: Row) => (r.decision === "approve" ? "approve" : "hold");
console.table(
  rows.map((r) => ({
    ...r,
    result: held(r) === r.correct ? "ok" : r.correct === "hold" ? "OVERSPEND ALLOWED" : "false hold",
  })),
);
const wrong = rows.filter((r) => held(r) !== r.correct);
console.log(
  `${rows.length - wrong.length} of ${rows.length} correct; ${wrong.filter((r) => r.correct === "hold").length} overspends allowed, ${wrong.filter((r) => r.correct === "approve").length} good payments held.`,
);

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
