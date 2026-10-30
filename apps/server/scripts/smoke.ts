/**
 * Call every endpoint of a running server, end to end, and say which ones answered as expected.
 *
 *   pnpm --filter @kairos/server smoke
 *
 * It signs up a throwaway account, works in that account's own workspaces, and deletes the
 * account at the end, which removes everything it made. Four of the calls are real decisions,
 * so the server needs a GRAYSON_API_KEY that works. With KAIROS_API_KEY set, it also reads
 * (and only reads) the workspace of that key.
 *
 * Outbound webhooks go to a receiver that this script runs on 127.0.0.1, so the server needs
 * KAIROS_WEBHOOKS_ALLOW_PRIVATE=1 and its job worker (KAIROS_WORKER=inline, or `pnpm worker`).
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const base = process.env.KAIROS_URL || "http://localhost:8787";
const run = randomBytes(4).toString("hex");
const email = `smoke-${run}@example.test`;
const password = randomBytes(12).toString("base64url");
const newPassword = randomBytes(12).toString("base64url");

let passed = 0;
const failures: string[] = [];
type Auth = { cookie?: string; key?: string; workspace?: string; origin?: string };

async function call(method: string, path: string, body?: unknown, auth: Auth = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth.cookie ? { Cookie: auth.cookie } : {}),
      ...(auth.key ? { Authorization: `Bearer ${auth.key}` } : {}),
      ...(auth.workspace ? { "X-Kairos-Workspace": auth.workspace } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: any = await response.json().catch(() => null);
  return { status: response.status, data, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]! };
}

/** One endpoint: the status it must answer with, and anything that must be true of the answer. */
async function check(
  name: string,
  expected: number,
  request: Promise<{ status: number; data: any; cookie: string }>,
  holds?: (data: any) => unknown,
) {
  const started = Date.now();
  const result = await request;
  let problem =
    result.status === expected
      ? ""
      : `status ${result.status}, expected ${expected}: ${JSON.stringify(result.data)?.slice(0, 200)}`;
  if (!problem && holds) {
    try {
      if (!holds(result.data)) problem = `unexpected answer: ${JSON.stringify(result.data)?.slice(0, 200)}`;
    } catch (cause) {
      problem = `unexpected answer (${(cause as Error).message})`;
    }
  }
  if (problem) failures.push(`${name} — ${problem}`);
  else passed++;
  console.log(
    `${problem ? "FAIL" : " ok "}  ${name.padEnd(58)} ${String(Date.now() - started).padStart(5)} ms${problem ? `\n      ${problem}` : ""}`,
  );
  return result;
}

const section = (title: string) => console.log(`\n${title}`);

/** Ask again until `ready` holds or `ms` pass: for what the job worker does in the background. */
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => unknown, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ready(value) || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface Received {
  headers: Record<string, string>;
  body: string;
  json: any;
}
const received: Received[] = [];
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    received.push({ headers: req.headers as Record<string, string>, body, json: JSON.parse(body || "null") });
    res.writeHead(200).end("ok");
  });
});
await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
const messagesOf = (type: string) => received.filter((r) => r.json?.type === type);
/** Standard Webhooks, checked as a receiver would. */
const signedWith = (secret: string, r: Received) => {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = `${r.headers["webhook-id"]}.${r.headers["webhook-timestamp"]}.${r.body}`;
  return r.headers["webhook-signature"]
    ?.split(" ")
    .includes(`v1,${createHmac("sha256", key).update(signed).digest("base64")}`);
};
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

section("Server");
await check("GET /health", 200, call("GET", "/health"), (d) => d.ok);
await check("GET /auth/config", 200, call("GET", "/auth/config"), (d) => d.password === true);
await check("GET /v1/stats with no key", 401, call("GET", "/v1/stats"));
await check("GET /v1/stats with an unknown key", 401, call("GET", "/v1/stats", undefined, { key: "ksk_not_a_key" }));

section("Account");
const signup = await check(
  "POST /auth/signup",
  200,
  call("POST", "/auth/signup", { email, password, name: "Smoke Test" }),
  (d) => d.workspaces.length === 1,
);
if (signup.status !== 200) {
  console.error("\nSign-up failed (is sign-up by invite only?). Nothing else can run.");
  process.exit(1);
}
let me: Auth = { cookie: signup.cookie };
const home: string = signup.data.workspaces[0].id;
try {
  await check(
    "GET /auth/me",
    200,
    call("GET", "/auth/me", undefined, me),
    (d) => d.user.email === email && d.user.has_password,
  );
  await check(
    "PATCH /auth/me",
    200,
    call("PATCH", "/auth/me", { name: "Smoke Renamed" }, me),
    (d) => d.user.name === "Smoke Renamed",
  );
  await check("POST /auth/logout", 200, call("POST", "/auth/logout", undefined, me));
  await check("GET /auth/me after logout", 401, call("GET", "/auth/me", undefined, me));
  await check(
    "POST /auth/login with a wrong password",
    401,
    call("POST", "/auth/login", { email, password: "not the password" }),
  );
  const login = await check("POST /auth/login", 200, call("POST", "/auth/login", { email, password }));
  me = { cookie: login.cookie };
  await check(
    "POST /auth/password",
    200,
    call("POST", "/auth/password", { current: password, password: newPassword }, me),
    (d) => d.ok,
  );

  section("Workspaces, members, invites");
  const second = await check(
    "POST /app/workspaces",
    200,
    call("POST", "/app/workspaces", { name: `Smoke ${run}` }, me),
    (d) => d.role === "owner",
  );
  const extra: string = second.data.id;
  await check(
    "PATCH /app/workspaces/:id",
    200,
    call("PATCH", `/app/workspaces/${extra}`, { name: `Smoke two ${run}` }, me),
    (d) => d.name === `Smoke two ${run}`,
  );
  await check(
    "GET /app/workspaces/:id/members",
    200,
    call("GET", `/app/workspaces/${home}/members`, undefined, me),
    (d) => d.members.length === 1 && d.members[0].role === "owner",
  );
  await check(
    "GET members of a workspace you are not in",
    404,
    call("GET", "/app/workspaces/ws_none/members", undefined, me),
  );
  const invite = await check(
    "POST /app/workspaces/:id/invites",
    200,
    call("POST", `/app/workspaces/${home}/invites`, { email: `guest-${run}@example.test`, role: "member" }, me),
    (d) => d.token,
  );
  await check(
    "GET /auth/invites/:token",
    200,
    call("GET", `/auth/invites/${invite.data.token}`),
    (d) => d.has_account === false && d.role === "member",
  );
  await check(
    "POST /auth/invites/:token/accept as the wrong person",
    403,
    call("POST", `/auth/invites/${invite.data.token}/accept`, undefined, me),
  );
  await check(
    "DELETE /app/workspaces/:id/invites/:invite",
    200,
    call("DELETE", `/app/workspaces/${home}/invites/${invite.data.invite.id}`, undefined, me),
  );
  await check("GET /auth/invites/:token after revoke", 404, call("GET", `/auth/invites/${invite.data.token}`));
  await check(
    "PATCH own role, the only owner",
    409,
    call("PATCH", `/app/workspaces/${home}/members/${signup.data.user.id}`, { role: "member" }, me),
  );
  await check(
    "DELETE the only owner",
    409,
    call("DELETE", `/app/workspaces/${home}/members/${signup.data.user.id}`, undefined, me),
  );

  section("API keys");
  const secretKey = await check(
    "POST /app/workspaces/:id/keys (secret)",
    200,
    call("POST", `/app/workspaces/${home}/keys`, { name: "smoke secret", kind: "secret" }, me),
    (d) => d.secret.startsWith("ksk_"),
  );
  const publicKey = await check(
    "POST /app/workspaces/:id/keys (public)",
    200,
    call("POST", `/app/workspaces/${home}/keys`, { name: "smoke public", kind: "public" }, me),
    (d) => d.secret.startsWith("kpk_"),
  );
  const spare = await check(
    "POST /app/workspaces/:id/keys (to revoke)",
    200,
    call("POST", `/app/workspaces/${home}/keys`, { name: "smoke spare", kind: "secret" }, me),
  );
  await check(
    "POST keys with a bad IP rule",
    400,
    call("POST", `/app/workspaces/${home}/keys`, { name: "bad", kind: "secret", allowed_ips: ["not-an-ip"] }, me),
  );
  await check(
    "GET /app/workspaces/:id/keys",
    200,
    call("GET", `/app/workspaces/${home}/keys`, undefined, me),
    (d) => d.keys.length === 3 && !JSON.stringify(d).includes(secretKey.data.secret),
  );
  await check(
    "DELETE /app/workspaces/:id/keys/:key",
    200,
    call("DELETE", `/app/workspaces/${home}/keys/${spare.data.key.id}`, undefined, me),
    (d) => d.keys.some((k: any) => k.revoked),
  );
  await check(
    "GET /v1/stats with the revoked key",
    401,
    call("GET", "/v1/stats", undefined, { key: spare.data.secret }),
  );
  const key: Auth = { key: secretKey.data.secret };
  const pub: Auth = { key: publicKey.data.secret };

  section("Entities and labels");
  const user = `user_${run}`;
  const other = `user_other_${run}`;
  await check(
    "PUT /v1/entity-types/:type",
    200,
    call(
      "PUT",
      "/v1/entity-types/user",
      { kind: "person", description: "A customer", properties: { country: "Country of residence" }, link: false },
      key,
    ),
    (d) => d.type === "user",
  );
  await check("PUT /v1/entity-types/:type, not valid", 400, call("PUT", "/v1/entity-types/user", { kind: 7 }, key));
  await check(
    "GET /v1/entity-types/:type",
    200,
    call("GET", "/v1/entity-types/user", undefined, key),
    (d) => d.kind === "person",
  );
  await check(
    "GET /v1/entity-types/:type, not defined",
    404,
    call("GET", "/v1/entity-types/spaceship", undefined, key),
  );
  await check(
    "PUT /v1/objects",
    200,
    call(
      "PUT",
      "/v1/objects",
      {
        batch: [
          { type: "user", id: user, properties: { country: "GB", plan: "pro" } },
          { type: "device", id: `dev_${run}`, properties: { os: "ios" } },
        ],
      },
      key,
    ),
    (d) => d.accepted === 2,
  );
  await check(
    "PUT /v1/entities/:type/:id",
    200,
    call("PUT", `/v1/entities/user/${other}`, { properties: { country: "NG", age: 41 } }, key),
    (d) => d.properties.age === 41,
  );
  await check(
    "GET /v1/objects/:type/:id",
    200,
    call("GET", `/v1/objects/user/${user}`, undefined, key),
    (d) => d.properties.plan === "pro",
  );
  await check("GET /v1/objects/:type/:id, unknown", 404, call("GET", "/v1/objects/user/nobody", undefined, key));
  await check(
    "POST /v1/labels",
    200,
    call(
      "POST",
      "/v1/labels",
      { batch: [{ entity: { type: "user", id: other }, label: "fraud_confirmed", properties: { source: "smoke" } }] },
      key,
    ),
    (d) => d.accepted === 1,
  );

  section("Events and records");
  const events = [
    {
      id: `e1_${run}`,
      type: "login",
      ts: ago(180),
      entities: { user, device: `dev_${run}` },
      properties: { ip_country: "GB" },
    },
    {
      id: `e2_${run}`,
      type: "deposit_bank",
      ts: ago(120),
      entities: { user },
      properties: { usd: 500 },
      set: { user: { tier: "gold" } },
      set_once: { user: { signup_country: "GB", country: "FR" } },
    },
    {
      id: `e3_${run}`,
      type: "card_payment",
      ts: ago(90),
      entities: { user },
      properties: { usd: 40 },
      universal_id: `txn_${run}`,
      status: "pending",
    },
    {
      id: `e4_${run}`,
      type: "card_payment",
      ts: ago(60),
      entities: { user },
      properties: { usd: 40 },
      universal_id: `txn_${run}`,
      status: "completed",
    },
    {
      id: `e5_${run}`,
      type: "login",
      ts: ago(30),
      entities: { user: other, device: `dev_${run}` },
      properties: { ip_country: "NG" },
    },
  ];
  await check(
    "POST /v1/events",
    202,
    call("POST", "/v1/events", { batch: events }, key),
    (d) => d.accepted === 5 && d.duplicates === 0,
  );
  await check(
    "POST /v1/events, the same ids again",
    202,
    call("POST", "/v1/events", { batch: events.slice(0, 2) }, key),
    (d) => d.accepted === 0 && d.duplicates === 2,
  );
  await check(
    "POST /v1/events, not valid",
    400,
    call("POST", "/v1/events", { batch: [{ id: "x", type: "t", ts: "yesterday", entities: { user } }] }, key),
  );
  await check(
    "POST /v1/events with a public key",
    202,
    call(
      "POST",
      "/v1/events",
      {
        batch: [
          { id: `e6_${run}`, type: "page_view", ts: ago(20), entities: { user }, properties: { path: "/pricing" } },
        ],
      },
      pub,
    ),
    (d) => d.accepted === 1,
  );
  await check(
    "POST /v1/events with a public key and set",
    403,
    call(
      "POST",
      "/v1/events",
      {
        batch: [
          {
            id: `e7_${run}`,
            type: "page_view",
            ts: ago(19),
            entities: { user },
            properties: {},
            set: { user: { tier: "hacked" } },
          },
        ],
      },
      pub,
    ),
  );
  await check("GET /v1/stats with a public key", 403, call("GET", "/v1/stats", undefined, pub));
  await check(
    "set and set_once reached the entity",
    200,
    call("GET", `/v1/objects/user/${user}`, undefined, key),
    (d) => d.properties.tier === "gold" && d.properties.signup_country === "GB" && d.properties.country === "GB",
  );
  await check(
    "GET /v1/records/:id",
    200,
    call("GET", `/v1/records/txn_${run}`, undefined, key),
    (d) => d.status === "completed" && d.stages.length === 2,
  );
  await check("GET /v1/records/:id, unknown", 404, call("GET", "/v1/records/txn_none", undefined, key));

  section("Actions and decisions (two real model calls)");
  const action = {
    displayName: "Smoke Withdrawal",
    subject: "user",
    hold: "Should this withdrawal be held because the account shows signs of fraud or takeover?",
    reasons: {
      new_device: "The request comes from a device the user has not used before",
      large_amount: "The amount is large against the money that came in recently",
    },
    trigger: "withdrawal_requested",
    context: { totals: [{ name: "money_in", event: "deposit_bank", sum: "usd", window: "7d" }] },
  };
  const defined = await check(
    "PUT /v1/actions/:name",
    200,
    call("PUT", "/v1/actions/smoke_withdrawal", action, key),
    (d) => d.version === 1,
  );
  await check(
    "PUT /v1/actions/:name, the same again",
    200,
    call("PUT", "/v1/actions/smoke_withdrawal", action, key),
    (d) => d.version === 1,
  );
  await check(
    "PUT /v1/actions/:name, a new display name",
    200,
    call("PUT", "/v1/actions/smoke_withdrawal", { ...action, displayName: "Smoke Payout" }, key),
    (d) => d.version === 1 && d.displayName === "Smoke Payout",
  );
  await check(
    "PUT /v1/actions/:name, new wording",
    200,
    call("PUT", "/v1/actions/smoke_withdrawal", { ...action, hold: `${action.hold} Consider the device.` }, key),
    (d) => d.version === 2,
  );
  await check("PUT /v1/actions/:name, not valid", 400, call("PUT", "/v1/actions/broken", { subject: "user" }, key));
  await check(
    "PUT a second action on the same trigger",
    400,
    call(
      "PUT",
      "/v1/actions/smoke_other",
      { subject: "user", hold: action.hold, trigger: "withdrawal_requested" },
      key,
    ),
  );
  await check("GET /v1/actions", 200, call("GET", "/v1/actions", undefined, key), (d) => d.actions.length === 1);
  await check(
    "GET /v1/actions/:name",
    200,
    call("GET", "/v1/actions/smoke_withdrawal", undefined, key),
    (d) => d.version === 2,
  );
  await check("GET /v1/actions/:name, unknown", 404, call("GET", "/v1/actions/nothing", undefined, key));
  await check("GET /v1/templates", 200, call("GET", "/v1/templates", undefined, key), (d) =>
    Array.isArray(d.templates),
  );
  await check(
    "POST /v1/decide, unknown action",
    404,
    call("POST", "/v1/decide", { action: "nothing", entities: { user }, properties: {} }, key),
  );
  await check(
    "POST /v1/decide, no subject",
    400,
    call("POST", "/v1/decide", { action: "smoke_withdrawal", entities: { device: "d" }, properties: {} }, key),
  );
  const decided = await check(
    "POST /v1/decide",
    200,
    call(
      "POST",
      "/v1/decide",
      { action: "smoke_withdrawal", entities: { user, device: `dev_new_${run}` }, properties: { usd: 450 } },
      key,
    ),
    (d) =>
      ["approve", "step_up", "review", "block"].includes(d.decision) &&
      typeof d.probability === "number" &&
      d.decision_id,
  );
  const trigger = {
    id: `w1_${run}`,
    type: "withdrawal_requested",
    ts: new Date().toISOString(),
    entities: { user, device: `dev_${run}` },
    properties: { usd: 120 },
  };
  const viaEvent = await check(
    "POST /v1/events/decide",
    200,
    call("POST", "/v1/events/decide", trigger, key),
    (d) => d.event_id === trigger.id && d.decision_id,
  );
  await check(
    "POST /v1/events/decide, the same event again",
    200,
    call("POST", "/v1/events/decide", trigger, key),
    (d) => d.decision_id === viaEvent.data?.decision_id,
  );
  await check(
    "POST /v1/events/decide, no action for the event",
    404,
    call("POST", "/v1/events/decide", { ...trigger, id: `n1_${run}`, type: "nothing_happened" }, key),
  );
  await check(
    "GET /v1/decisions",
    200,
    call("GET", "/v1/decisions?limit=10", undefined, key),
    (d) => d.total === 2 && d.decisions.length === 2,
  );
  await check(
    "GET /v1/decisions, filtered",
    200,
    call(
      "GET",
      `/v1/decisions?action=smoke_withdrawal&subject_type=user&subject_id=${user}&limit=1&offset=1`,
      undefined,
      key,
    ),
    (d) => d.total === 2 && d.decisions.length === 1,
  );
  await check(
    "GET /v1/decisions/:id",
    200,
    call("GET", `/v1/decisions/${decided.data?.decision_id}`, undefined, key),
    (d) => d.context && d.raw && d.subject.id === user,
  );
  await check(
    "the decision saw the total",
    200,
    call("GET", `/v1/decisions/${decided.data?.decision_id}`, undefined, key),
    (d) => JSON.stringify(d.context).includes("money_in"),
  );
  await check("GET /v1/decisions/:id, unknown", 404, call("GET", "/v1/decisions/kdec_none", undefined, key));

  section("Sessions (one real model call)");
  const sid = `sess_${run}`;
  const inSession = (id: string, minutes: number, type: string, who = user, properties = {}) => ({
    id: `${id}_${run}`,
    type,
    ts: ago(minutes),
    entities: { user: who },
    properties,
    session: sid,
  });
  await check(
    "POST /v1/events with a session",
    202,
    call(
      "POST",
      "/v1/events",
      {
        batch: [
          inSession("s1", 6, "login"),
          inSession("s2", 5, "password_changed"),
          inSession("s3", 4, "card_payment", user, { usd: 75 }),
          inSession("s4", 3, "login", other),
        ],
      },
      key,
    ),
    (d) => d.accepted === 4,
  );
  await check(
    "PUT an action with a total for the session",
    200,
    call(
      "PUT",
      "/v1/actions/smoke_session",
      {
        subject: "user",
        hold: action.hold,
        context: { totals: [{ name: "spent", event: "card_payment", sum: "usd", window: "session" }] },
      },
      key,
    ),
  );
  const inVisit = await check(
    "POST /v1/decide with a session",
    200,
    call(
      "POST",
      "/v1/decide",
      { action: "smoke_session", entities: { user }, properties: { usd: 20 }, session: sid },
      key,
    ),
    (d) => d.decision_id,
  );
  await check(
    "the decision saw its session",
    200,
    call("GET", `/v1/decisions/${inVisit.data?.decision_id}`, undefined, key),
    (d) =>
      d.session === sid &&
      d.context.this_session.events === 4 &&
      d.context.this_session.steps[1] === "+1:00 password_changed" &&
      d.context.this_session.other_users_in_this_session === 1 &&
      d.context.totals.spent_this_session.sum === 75,
  );
  await check(
    "GET /v1/sessions/:id",
    200,
    call("GET", `/v1/sessions/${sid}`, undefined, key),
    (d) => d.events.length === 4 && d.decisions.length === 1 && d.entities.user.length === 2,
  );
  await check(
    "GET /v1/sessions",
    200,
    call("GET", "/v1/sessions?outcome=any", undefined, key),
    (d) =>
      d.total === 1 &&
      d.sessions[0].id === sid &&
      d.sessions[0].events === 4 &&
      d.sessions[0].decisions === 1 &&
      d.sessions[0].entities.user.length === 2,
  );
  await check("GET /v1/sessions/:id, unknown", 404, call("GET", "/v1/sessions/nothing", undefined, key));
  await check(
    "GET /v1/decisions?session=",
    200,
    call("GET", `/v1/decisions?session=${sid}`, undefined, key),
    (d) => d.total === 1,
  );
  await check(
    "the entity lists its sessions",
    200,
    call("GET", `/v1/entities/user/${user}`, undefined, key),
    (d) => d.sessions.length === 1 && d.sessions[0].id === sid && d.sessions[0].events === 3,
  );

  section("Lists, counts and metrics");
  await check(
    "GET /v1/stats",
    200,
    call("GET", "/v1/stats", undefined, key),
    (d) => d.events === 11 && d.decisions === 3 && d.actions === 2,
  );
  await check(
    "GET /v1/usage",
    200,
    call("GET", "/v1/usage?days=7", undefined, key),
    (d) => d.stored.events === 11 && d.by_action[0].action === "smoke_withdrawal" && d.by_action[0].input_tokens > 0,
  );
  await check("GET /v1/overview", 200, call("GET", "/v1/overview", undefined, key), (d) => d && typeof d === "object");
  await check(
    "GET /v1/entity-types",
    200,
    call("GET", "/v1/entity-types", undefined, key),
    (d) => d.types.find((t: any) => t.type === "user").count === 2,
  );
  await check(
    "GET /v1/entity-types/:type/shape",
    200,
    call("GET", "/v1/entity-types/user/shape", undefined, key),
    (d) => d.properties.some((p: any) => p.name === "country") && d.events.length > 0,
  );
  await check(
    "GET /v1/entities",
    200,
    call("GET", "/v1/entities", undefined, key),
    (d) => d.type === null && d.types.length >= 2,
  );
  await check(
    "GET /v1/entities?type=",
    200,
    call("GET", "/v1/entities?type=user&sort=events", undefined, key),
    (d) => d.total === 2 && d.entities[0].id === user,
  );
  await check(
    "GET /v1/entities, by property",
    200,
    call("GET", "/v1/entities?type=user&prop=country:eq:gb", undefined, key),
    (d) => d.total === 1 && d.entities[0].id === user,
  );
  await check(
    "GET /v1/entities, by number and label",
    200,
    call("GET", "/v1/entities?type=user&prop=age:gt:40&label=fraud_confirmed", undefined, key),
    (d) => d.total === 1 && d.entities[0].id === other,
  );
  await check(
    "GET /v1/entities, by decision",
    200,
    call("GET", "/v1/entities?type=user&outcome=none&q=other", undefined, key),
    (d) => d.total === 1 && d.entities[0].id === other,
  );
  await check(
    "GET /v1/entities, a bad condition",
    400,
    call("GET", "/v1/entities?type=user&prop=country:like:GB", undefined, key),
  );
  await check(
    "GET /v1/entities/:type/:id",
    200,
    call("GET", `/v1/entities/user/${user}`, undefined, key),
    (d) => d.events.length === 9 && d.decisions.length === 3,
  );
  await check("GET /v1/entities/:type/:id, unknown", 404, call("GET", "/v1/entities/user/nobody", undefined, key));
  const period = { from: ago(60 * 24), to: new Date(now + 3_600_000).toISOString() };
  await check(
    "POST /v1/metrics/query, events by type",
    200,
    call(
      "POST",
      "/v1/metrics/query",
      { ...period, source: "events", group_by: "event_type", interval: "day", compare: true },
      key,
    ),
    (d) => d.total === 11 && d.truncated === false,
  );
  await check(
    "POST /v1/metrics/query, sum of a property",
    200,
    call(
      "POST",
      "/v1/metrics/query",
      { ...period, source: "events", measure: "sum", field: "usd", filters: { event_type: "deposit_bank" } },
      key,
    ),
    (d) => d.total === 500,
  );
  await check(
    "POST /v1/metrics/query, decisions by outcome",
    200,
    call("POST", "/v1/metrics/query", { ...period, source: "decisions", group_by: "outcome" }, key),
    (d) => d.total === 3,
  );
  await check(
    "POST /v1/metrics/query, labels",
    200,
    call("POST", "/v1/metrics/query", { ...period, source: "labels" }, key),
    (d) => d.total === 1,
  );
  await check(
    "POST /v1/metrics/query, to before from",
    400,
    call("POST", "/v1/metrics/query", { from: period.to, to: period.from, source: "events" }, key),
  );
  await check(
    "GET /v1/metrics/options",
    200,
    call("GET", "/v1/metrics/options?event_type=deposit_bank", undefined, key),
    (d) => d.actions.includes("smoke_withdrawal") && d.event_properties.some((p: any) => p.name === "usd" && p.numeric),
  );

  section("Dashboards");
  const tile = { id: "t1", title: "Decisions", view: "number", query: { source: "decisions" } };
  const session: Auth = { ...me, workspace: home };
  const shared = await check(
    "POST /v1/dashboards with a key",
    200,
    call("POST", "/v1/dashboards", { name: "Smoke shared", tiles: [tile] }, key),
    (d) => d.owner === null && d.tiles[0].w === 6,
  );
  await check(
    "POST /v1/dashboards, private with a key",
    400,
    call("POST", "/v1/dashboards", { name: "x", visibility: "private" }, key),
  );
  const mine = await check(
    "POST /v1/dashboards, private with a session",
    200,
    call("POST", "/v1/dashboards", { name: "Smoke private", visibility: "private", tiles: [] }, session),
    (d) => d.mine && d.can_manage,
  );
  await check(
    "GET /v1/dashboards with a session",
    200,
    call("GET", "/v1/dashboards", undefined, session),
    (d) => d.dashboards.length === 2,
  );
  await check(
    "GET /v1/dashboards with a key hides the private one",
    200,
    call("GET", "/v1/dashboards", undefined, key),
    (d) => d.dashboards.length === 1,
  );
  await check(
    "GET /v1/dashboards/:id",
    200,
    call("GET", `/v1/dashboards/${shared.data?.id}`, undefined, key),
    (d) => d.name === "Smoke shared",
  );
  await check(
    "GET a private dashboard with a key",
    404,
    call("GET", `/v1/dashboards/${mine.data?.id}`, undefined, key),
  );
  await check(
    "PUT /v1/dashboards/:id",
    200,
    call(
      "PUT",
      `/v1/dashboards/${shared.data?.id}`,
      {
        name: "Smoke shared",
        range: "7d",
        tiles: [
          { ...tile, w: 12 },
          { ...tile, id: "t2", view: "line" },
        ],
      },
      key,
    ),
    (d) => d.range === "7d" && d.tiles.length === 2,
  );
  await check("DELETE /v1/dashboards/:id", 200, call("DELETE", `/v1/dashboards/${shared.data?.id}`, undefined, key));
  await check(
    "GET /v1/dashboards/:id after delete",
    404,
    call("GET", `/v1/dashboards/${shared.data?.id}`, undefined, key),
  );

  section("Session on the data API, and isolation");
  await check(
    "GET /v1/stats with a session and a workspace",
    200,
    call("GET", "/v1/stats", undefined, session),
    (d) => d.events === 11,
  );
  await check("GET /v1/stats with a session and no workspace", 400, call("GET", "/v1/stats", undefined, me));
  await check(
    "the second workspace is empty",
    200,
    call("GET", "/v1/stats", undefined, { ...me, workspace: extra }),
    (d) => d.events === 0 && d.decisions === 0,
  );
  await check("a workspace you are not in", 403, call("GET", "/v1/stats", undefined, { ...me, workspace: "demo" }));
  if (process.env.KAIROS_API_KEY) {
    const yours: Auth = { key: process.env.KAIROS_API_KEY };
    await check(
      "KAIROS_API_KEY: GET /v1/stats",
      200,
      call("GET", "/v1/stats", undefined, yours),
      (d) => typeof d.events === "number",
    );
    await check(
      "KAIROS_API_KEY: cannot see this run's entity",
      404,
      call("GET", `/v1/entities/user/${user}`, undefined, yours),
    );
    await check("KAIROS_API_KEY: GET /v1/decisions", 200, call("GET", "/v1/decisions?limit=1", undefined, yours), (d) =>
      Array.isArray(d.decisions),
    );
  }

  section("Outbound webhooks (needs KAIROS_WEBHOOKS_ALLOW_PRIVATE=1)");
  const hooks = `/app/workspaces/${home}/webhooks`;
  const endpoint = await check(
    "POST /app/workspaces/:id/webhooks (out)",
    200,
    call(
      "POST",
      hooks,
      {
        direction: "out",
        name: "smoke receiver",
        url: receiverUrl,
        events: ["decision.created", "decision.updated", "label.created"],
      },
      me,
    ),
    (d) => d.secret.startsWith("whsec_") && d.webhook.enabled,
  );
  const signingSecret: string = endpoint.data.secret;
  const hook: string = endpoint.data.webhook.id;
  await check(
    "POST /app/workspaces/:id/webhooks/:id/test",
    200,
    call("POST", `${hooks}/${hook}/test`, undefined, me),
    (d) => d.delivered && d.status === 200,
  );
  await check(
    "the test message is signed",
    200,
    Promise.resolve({ status: 200, data: messagesOf("webhook.test"), cookie: "" }),
    (m) => m.length === 1 && signedWith(signingSecret, m[0]),
  );
  await check(
    "POST webhooks (out) with a bad URL",
    400,
    call("POST", hooks, { direction: "out", name: "bad", url: "ftp://example.com", events: ["label.created"] }, me),
  );

  section("Automatic decisions (one real model call)");
  const payoutEvent = `payout_${run}`;
  await check(
    "PUT an automatic action",
    200,
    call(
      "PUT",
      "/v1/actions/smoke_payout",
      {
        subject: "user",
        hold: "Should this payout be held because the account shows signs of fraud?",
        trigger: { event: payoutEvent, status: "requested" },
        automatic: true,
      },
      key,
    ),
    (d) => d.automatic === true && typeof d.automaticSince === "string",
  );
  await check(
    "POST /v1/events that the action decides",
    202,
    call(
      "POST",
      "/v1/events",
      {
        batch: [
          {
            id: `p1_${run}`,
            type: payoutEvent,
            ts: ago(1),
            entities: { user },
            properties: { usd: 2500 },
            status: "requested",
          },
        ],
      },
      key,
    ),
    (d) => d.accepted === 1,
  );
  const automatic = await check(
    "the job worker made the decision",
    200,
    eventually(
      () => call("GET", "/v1/decisions?action=smoke_payout", undefined, key),
      (r) => r.data?.decisions?.length > 0,
    ),
    (d) => d.decisions.length === 1 && d.decisions[0].automatic === true,
  );
  const automaticId: string = automatic.data.decisions[0]?.id;
  await check(
    "decision.created reached the receiver, signed",
    200,
    eventually(
      async () => ({ status: 200, data: messagesOf("decision.created"), cookie: "" }),
      (r) => r.data.some((m: Received) => m.json.data.decision_id === automaticId),
    ),
    (m) =>
      m.some(
        (r: Received) =>
          r.json.data.decision_id === automaticId && r.json.data.automatic && signedWith(signingSecret, r),
      ),
  );
  await check(
    "POST /v1/events, the same payout again, decides nothing more",
    202,
    call(
      "POST",
      "/v1/events",
      { batch: [{ id: `p1_${run}`, type: payoutEvent, ts: ago(1), entities: { user }, status: "requested" }] },
      key,
    ),
    (d) => d.duplicates === 1,
  );

  section("Resolutions and labels go out by webhook");
  await check(
    "POST /v1/decisions/:id/resolution",
    200,
    call("POST", `/v1/decisions/${automaticId}/resolution`, { outcome: "block", note: "Confirmed by smoke" }, key),
    (d) => d.revision === 2 && d.final_outcome === "block",
  );
  await check(
    "decision.updated reached the receiver",
    200,
    eventually(
      async () => ({ status: 200, data: messagesOf("decision.updated"), cookie: "" }),
      (r) => r.data.length > 0,
    ),
    (m) => m[0].json.data.revision === 2 && m[0].json.data.final_outcome === "block",
  );
  await check(
    "POST /v1/labels, a new and recent label",
    200,
    call("POST", "/v1/labels", { batch: [{ entity: { type: "user", id: user }, label: `mule_${run}` }] }, key),
  );
  await check(
    "label.created reached the receiver",
    200,
    eventually(
      async () => ({ status: 200, data: messagesOf("label.created"), cookie: "" }),
      (r) => r.data.length > 0,
    ),
    (m) => m[0].json.data.label === `mule_${run}` && m[0].json.data.recent_decisions.length >= 1,
  );
  const log = await check(
    "GET /app/workspaces/:id/webhooks/:id/deliveries",
    200,
    call("GET", `${hooks}/${hook}/deliveries`, undefined, me),
    (d) => d.deliveries.length >= 4 && d.deliveries.every((x: any) => x.status === "delivered"),
  );
  const firstSent = log.data.deliveries.find((x: any) => x.type === "decision.created");
  const before = received.length;
  await check(
    "POST /app/workspaces/:id/webhooks/:id/resend",
    200,
    call("POST", `${hooks}/${hook}/resend`, { delivery: firstSent?.id }, me),
  );
  await check(
    "the resend keeps the message id",
    200,
    eventually(
      async () => ({ status: 200, data: received.slice(before), cookie: "" }),
      (r) => r.data.length > 0,
    ),
    (m) => m[0].headers["webhook-id"] === firstSent.external_id,
  );
  await check(
    "GET /app/workspaces/:id/webhook-deliveries?subject=",
    200,
    call("GET", `/app/workspaces/${home}/webhook-deliveries?subject=decision:${automaticId}`, undefined, me),
    (d) => d.deliveries.length >= 2 && d.deliveries[0].webhook_name === "smoke receiver",
  );
  await check(
    "GET /app/workspaces/:id/webhooks",
    200,
    call("GET", hooks, undefined, me),
    (d) => d.webhooks.find((w: any) => w.id === hook)?.deliveries_24h >= 4,
  );

  section("Inbound webhooks");
  const inboundSecret = randomBytes(16).toString("hex");
  const source = await check(
    "POST /app/workspaces/:id/webhooks (in)",
    200,
    call(
      "POST",
      hooks,
      {
        direction: "in",
        name: "smoke provider",
        verification: { scheme: "hmac", header: "X-Smoke-Signature", algorithm: "sha256", encoding: "hex" },
        secret: inboundSecret,
        mapping: {
          rules: [
            {
              name: "Order",
              match: { type: "order.paid" },
              event: {
                id: "$.id",
                type: "order_paid",
                ts: { path: "$.created", format: "unix_seconds" },
                entities: { user: "$.user" },
                properties: { usd: "$.amount" },
              },
            },
          ],
        },
      },
      me,
    ),
    (d) => d.path.startsWith("/v1/webhooks/whk_"),
  );
  const deliver = (payload: unknown, secret = inboundSecret, path: string = source.data.path) => {
    const raw = JSON.stringify(payload);
    return fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Smoke-Signature": createHmac("sha256", secret).update(raw).digest("hex"),
      },
      body: raw,
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null), cookie: "" }));
  };
  const order = { id: `ord_${run}`, type: "order.paid", created: Math.floor(now / 1000) - 120, user, amount: 75 };
  await check("POST /v1/webhooks/:token", 200, deliver(order), (d) => d.status === "stored");
  await check("POST /v1/webhooks/:token, the same delivery", 200, deliver(order), (d) => d.status === "duplicate");
  await check("POST /v1/webhooks/:token, a wrong signature", 401, deliver(order, "not the secret"));
  await check(
    "POST /v1/webhooks/:token, an unknown token",
    404,
    deliver(order, inboundSecret, "/v1/webhooks/whk_none"),
  );
  await check(
    "the mapped event is in the entity's timeline",
    200,
    call("GET", `/v1/entities/user/${user}`, undefined, key),
    (d) => d.events.some((e: any) => e.type === "order_paid" && e.properties.usd === 75),
  );
  await check(
    "POST /v1/webhooks/:token, no user in it",
    200,
    deliver({ ...order, id: `ord2_${run}`, user: undefined }),
    (d) => d.status === "no_entity",
  );
  await check(
    "POST /app/workspaces/:id/webhooks/:id/replay",
    200,
    call("POST", `${hooks}/${source.data.webhook.id}/replay`, { status: "failed" }, me),
    (d) => d.replayed === 1 && d.statuses.no_entity === 1,
  );
  await check(
    "GET the source's deliveries",
    200,
    call("GET", `${hooks}/${source.data.webhook.id}/deliveries`, undefined, me),
    (d) => ["stored", "duplicate", "rejected", "no_entity"].every((s) => d.deliveries.some((x: any) => x.status === s)),
  );

  section("Environments");
  const environments = await check(
    "GET /app/workspaces/:id/environments",
    200,
    call("GET", `/app/workspaces/${home}/environments`, undefined, me),
    (d) => d.environments.length === 1 && d.environments[0].kind === "production",
  );
  const production: string = environments.data.environments[0].id;
  const productionEvents = (await call("GET", "/v1/stats", undefined, key)).data.events;
  const sandbox = await check(
    "POST /app/workspaces/:id/environments, a copy of the actions and entities",
    201,
    call(
      "POST",
      `/app/workspaces/${home}/environments`,
      { name: `Smoke sandbox ${run}`, copy_from: production, copy: { actions: true, entities: true } },
      me,
    ),
    (d) => d.kind === "sandbox",
  );
  const sandboxId: string = sandbox.data.id;
  const sandboxKey = await check(
    "POST a key for the sandbox",
    200,
    call(
      "POST",
      `/app/workspaces/${home}/keys`,
      { name: "smoke sandbox", kind: "secret", environment_id: sandboxId },
      me,
    ),
  );
  const inSandbox: Auth = { key: sandboxKey.data.secret };
  await check(
    "the sandbox has the actions",
    200,
    call("GET", "/v1/actions", undefined, inSandbox),
    (d) => d.actions.some((a: any) => a.name === "smoke_payout") && d.actions.every((a: any) => !a.automatic),
  );
  await check(
    "the sandbox has the entity, and no events",
    200,
    call("GET", `/v1/objects/user/${user}`, undefined, inSandbox),
    (d) => d.properties.tier === "gold",
  );
  await check(
    "GET /v1/stats in the sandbox",
    200,
    call("GET", "/v1/stats", undefined, inSandbox),
    (d) => d.events === 0,
  );
  await check(
    "POST /v1/events in the sandbox",
    202,
    call(
      "POST",
      "/v1/events",
      { batch: [{ id: `s1_${run}`, type: "login", ts: ago(5), entities: { user } }] },
      inSandbox,
    ),
  );
  await check(
    "production does not see the sandbox's event",
    200,
    call("GET", "/v1/stats", undefined, key),
    (d) => d.events === productionEvents,
  );
  await check(
    "PATCH /app/workspaces/:id/environments/:id",
    200,
    call("PATCH", `/app/workspaces/${home}/environments/${sandboxId}`, { name: `Smoke sandbox two ${run}` }, me),
  );
  await check(
    "DELETE /app/workspaces/:id/environments/:id",
    200,
    call("DELETE", `/app/workspaces/${home}/environments/${sandboxId}`, { confirm: `Smoke sandbox two ${run}` }, me),
  );
  await check("the sandbox key after the delete", 401, call("GET", "/v1/stats", undefined, inSandbox));

  section("Deletion");
  await check(
    "DELETE /app/workspaces/:id, wrong name",
    400,
    call("DELETE", `/app/workspaces/${extra}`, { confirm: "nope" }, me),
  );
  await check(
    "DELETE /app/workspaces/:id",
    200,
    call("DELETE", `/app/workspaces/${extra}`, { confirm: `Smoke two ${run}` }, me),
  );
  await check("DELETE /auth/me, wrong password", 403, call("DELETE", "/auth/me", { password }, me));
  await check(
    "DELETE /auth/me",
    200,
    call("DELETE", "/auth/me", { password: newPassword }, me),
    (d) => d.workspaces_deleted === 1,
  );
  await check("the key of the deleted workspace", 401, call("GET", "/v1/stats", undefined, key));
  await check("POST /auth/login after delete", 401, call("POST", "/auth/login", { email, password: newPassword }));
} catch (cause) {
  failures.push(`The run stopped: ${(cause as Error).message}`);
  console.error(cause);
  // Leave nothing behind, whichever password the account has at this point.
  for (const p of [newPassword, password]) await call("DELETE", "/auth/me", { password: p }, me).catch(() => null);
}

receiver.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
