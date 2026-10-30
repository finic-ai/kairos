/**
 * Sessions, end to end against a local server: the same customer, the same withdrawal, in
 * two visits. In the first she looks at her balance and takes out money. In the second,
 * someone signs in from a new device, changes the password and the email address, adds a
 * payee and takes out money, all in four minutes.
 *
 *   GRAYSON_API_KEY=... pnpm api         with KAIROS_API_KEY in .env: a secret key from the console (Settings › API keys)
 *   pnpm example:session
 *
 * `$session` is the id of the login session in your own system. Kairos reads events with the
 * same `$session` as one visit, and a decision sees what happened in its visit before it.
 */
import { Kairos } from "../packages/sdk/src/index.js";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY ?? missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  decideTimeoutMs: 15_000,
});

const run = Date.now().toString(36);
const user = `user_dana_${run}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const DAY = 24 * 60;

const action = await kairos.defineAction("session_withdrawal", {
  displayName: "Withdrawal (sessions)",
  subject: "user",
  hold: "Should this withdrawal be held because the account shows signs of having been taken over by someone who is not its owner?",
  reasons: {
    new_device: "The request comes from a device the user has not used before",
    credentials_changed: "The password, the email address or the phone number was changed shortly before the request",
    new_payee: "The money goes to a payee that was added shortly before the request",
    rushed_session: "The session went from sign-in to moving money much faster than this user's usual visits",
  },
  trigger: "withdrawal_requested",
  // What left the account in this visit, whatever its length.
  context: { totals: [{ name: "money_out", event: "withdrawal", sum: "usd", window: "session" }] },
});
console.log(`action ${action.name}@${action.version}`);

// A year of ordinary visits: one a week, from her phone, each with its own session.
await kairos.setObject("user", user, { kyc_country: "GB", opened: "2024-03-02" });
for (let week = 52; week >= 1; week--) {
  const t = week * 7 * DAY;
  const $session = `sess_${run}_w${week}`;
  kairos.track("login", { userId: user, deviceId: `dev_phone_${run}`, ipCountry: "GB", $session, timestamp: ago(t) });
  kairos.track("view_balance", { userId: user, $session, timestamp: ago(t - 1) });
  if (week % 4 === 0)
    kairos.track("withdrawal", {
      userId: user,
      payeeId: `payee_own_bank_${run}`,
      usd: 300,
      $session,
      timestamp: ago(t - 3),
    });
}

// Visit one, an hour ago: the usual phone, a look at the balance, then the request.
const usual = `sess_${run}_usual`;
kairos.track("login", {
  userId: user,
  deviceId: `dev_phone_${run}`,
  ipCountry: "GB",
  $session: usual,
  timestamp: ago(66),
});
kairos.track("view_balance", { userId: user, $session: usual, timestamp: ago(64) });

// Visit two, now: a new device, then everything a takeover does, fast.
const takeover = `sess_${run}_takeover`;
kairos.track("login", {
  userId: user,
  deviceId: `dev_unknown_${run}`,
  ipCountry: "RO",
  $session: takeover,
  timestamp: ago(4),
});
kairos.track("password_changed", { userId: user, $session: takeover, timestamp: ago(3.5) });
kairos.track("email_changed", { userId: user, $session: takeover, timestamp: ago(3) });
kairos.track("payee_added", { userId: user, payeeId: `payee_new_${run}`, $session: takeover, timestamp: ago(2) });
kairos.track("withdrawal", {
  userId: user,
  payeeId: `payee_new_${run}`,
  usd: 900,
  $session: takeover,
  timestamp: ago(1),
});

// The same request in each visit. `timestamp` puts the first one where its visit was.
for (const [label, $session, request, timestamp] of [
  ["her usual visit", usual, { deviceId: `dev_phone_${run}`, payeeId: `payee_own_bank_${run}`, usd: 300 }, ago(62)],
  [
    "four minutes after a sign-in from a new device",
    takeover,
    { deviceId: `dev_unknown_${run}`, payeeId: `payee_new_${run}`, usd: 2400 },
    undefined,
  ],
] as const) {
  const started = Date.now();
  const { error, ...decision } = await kairos.trackAndDecide("withdrawal_requested", {
    userId: user,
    ...request,
    $session,
    ...(timestamp ? { timestamp } : {}),
  });
  console.log(`\n${label}  (${Date.now() - started} ms)\n  session ${$session}`);
  console.log(JSON.stringify(decision, null, 2));
}
console.log(
  `\nIn the console: #/entities/user/${user} lists both sessions, and #/sessions/${takeover} is the second one.`,
);

await kairos.shutdown();

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
