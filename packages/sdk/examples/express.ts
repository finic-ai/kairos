/**
 * The middleware, end to end against a local server: a small Express application whose
 * handlers never say who the user is. The same customer makes the same kind of withdrawal in
 * two visits. In the second, someone signs in from a new device, changes the password and the
 * email address, adds a payee and takes out money.
 *
 *   GRAYSON_API_KEY=... pnpm api         with KAIROS_API_KEY in .env: a secret key from the console (Settings › API keys)
 *   pnpm example:middleware
 *
 * The application makes three calls to Kairos: one event for the sign-in, one event for a
 * payee, and one decision. The middleware adds the user, the device and the session to each,
 * and sends the events for the password and the email address itself.
 */
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { Kairos } from "../src/index.js";
import { express as kairosExpress, setContext } from "../src/middleware.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      login?: { user: string; session: string };
    }
  }
}

const baseUrl = process.env.KAIROS_URL || "http://localhost:8787";
const apiKey = process.env.KAIROS_API_KEY ?? missingKey();
const kairos = new Kairos({
  apiKey,
  baseUrl,
  decideTimeoutMs: 15_000,
  onError: (error) => console.error("kairos:", error.message),
});

const run = Date.now().toString(36);
const user = `user_dana_${run}`;
const phone = `dev_phone_${run}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const DAY = 24 * 60;

const action = await kairos.defineAction("middleware_withdrawal", {
  displayName: "Withdrawal (middleware)",
  subject: "user",
  hold: "Should this withdrawal be held because the account shows signs of having been taken over by someone who is not its owner?",
  reasons: {
    new_device: "The request comes from a device the user has not used before",
    credentials_changed: "The password, the email address or the phone number was changed shortly before the request",
    new_payee: "The money goes to a payee that was added shortly before the request",
    rushed_session: "The session went from sign-in to moving money much faster than this user's usual visits",
  },
  trigger: "transfer_out_requested",
});
console.log(`action ${action.name}@${action.version}`);

/** The login sessions of the application: token → who. A real one keeps these in a store. */
const logins = new Map<string, { user: string; session: string }>();

const app = express();
app.use(express.json());
app.use(
  kairosExpress<Request>(kairos, {
    // Called when an event or a decision needs them, so they see what the sign-in below found.
    entities: (req) => ({ user: req.login?.user, device: req.get("x-kairos-device") }),
    session: (req) => req.login?.session,
    routes: {
      "PUT /account/password": { type: "password_changed", failed: "password_change_failed" },
      "PUT /account/email": "email_changed",
    },
  }),
);
app.use((req, _res, next) => {
  req.login = logins.get(req.get("authorization") ?? "");
  next();
});

app.post("/login", (req, res) => {
  const login = { user: req.body.user, session: `sess_${run}_${logins.size + 1}` };
  const token = `token_${logins.size + 1}`;
  logins.set(token, login);
  // This handler is where the user and the session become known.
  setContext(kairos, { entities: { user: login.user }, session: login.session });
  kairos.track("login", { ipCountry: req.body.country });
  res.json({ token, session: login.session });
});
app.put("/account/password", (req, res) => void res.status(req.login ? 204 : 401).end());
app.put("/account/email", (req, res) => void res.status(req.login ? 204 : 401).end());
app.post("/payees", (req, res) => {
  // An event with data of its own: the handler tracks it, and names only the payee.
  kairos.track("payee_added", { payeeId: req.body.payee });
  res.status(201).end();
});
app.post("/withdrawals", async (req, res) => {
  const decision = await kairos.trackAndDecide(
    "transfer_out_requested",
    { payeeId: req.body.payee, usd: req.body.usd },
    { fallback: "review" },
  );
  res.status(decision.decision === "approve" ? 201 : 202).json(decision);
});

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A year of ordinary visits, sent as history: one a week, from her phone.
await kairos.setObject("user", user, { kyc_country: "GB", opened: "2024-03-02" });
for (let week = 52; week >= 1; week--) {
  const t = week * 7 * DAY;
  const $session = `sess_${run}_w${week}`;
  kairos.track("login", { userId: user, deviceId: phone, ipCountry: "GB", $session, timestamp: ago(t) });
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
await kairos.flush();

/** A browser: every request carries its device, and its token once it has one. */
function browser(device: string) {
  let token = "";
  return async (method: string, path: string, body: unknown = {}) => {
    // A person takes longer than this. Two events in the same millisecond have no order.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", "x-kairos-device": device, authorization: token },
      body: JSON.stringify(body),
    });
    const answer =
      response.status === 204 || response.headers.get("content-length") === "0" ? {} : await response.json();
    if (answer.token) token = answer.token;
    return answer;
  };
}

const visits: [string, string][] = [];

// Visit one: her phone, and money to her own bank.
const hers = browser(phone);
const first = await hers("POST", "/login", { user, country: "GB" });
const usual = await hers("POST", "/withdrawals", { payee: `payee_own_bank_${run}`, usd: 300 });
visits.push(["her usual visit", first.session]);

// Visit two: a device nobody has seen, then everything a takeover does.
const theirs = browser(`dev_unknown_${run}`);
const second = await theirs("POST", "/login", { user, country: "RO" });
await theirs("PUT", "/account/password");
await theirs("PUT", "/account/email");
await theirs("POST", "/payees", { payee: `payee_new_${run}` });
const taken = await theirs("POST", "/withdrawals", { payee: `payee_new_${run}`, usd: 2400 });
visits.push(["a sign-in from a new device, then the password, the email address and a payee", second.session]);

// What the server holds for each visit: the application gave no user, device or session by hand.
await new Promise((resolve) => setTimeout(resolve, 50));
await kairos.flush();
for (const [[label, session], decision] of visits.map((visit, i) => [visit, [usual, taken][i]] as const)) {
  const stored = await (
    await fetch(`${baseUrl}/v1/sessions/${session}`, { headers: { authorization: `Bearer ${apiKey}` } })
  ).json();
  console.log(`\n${label}\n  session ${session}`);
  for (const event of stored.events ?? []) {
    const { source, http_method, http_route, http_status, ...rest } = event.properties ?? {};
    const from = source === "auto" ? `  ← the middleware, ${http_method} ${http_route} ${http_status}` : "";
    console.log(`  ${event.type.padEnd(22)} ${JSON.stringify({ ...event.entities, ...rest })}${from}`);
  }
  const { error: _error, ...answer } = decision;
  console.log(JSON.stringify(answer, null, 2));
}
console.log(
  `\nIn the console: #/entities/user/${user} lists both sessions, and #/sessions/${second.session} is the second one.`,
);

server.closeAllConnections();
server.close();
await kairos.shutdown();

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
