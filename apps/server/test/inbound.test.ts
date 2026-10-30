import { createHmac, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Webhooks } from "../src/context";
import { memberships, webhookDeliveries } from "../src/db/schema";
import { secretBox } from "../src/platform/secrets";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { loadPresets } from "../src/modules/webhooks/libs";
import { EnvironmentsService } from "../src/services/environment.service";
import { WebhookDeliveriesService } from "../src/services/webhook_delivery.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const START = new Date("2026-10-15T12:00:00Z");
const STRIPE_SECRET = "whsec_test_" + "s".repeat(24);

let clock: Date;
let app: ReturnType<typeof createApp>;
let hooks: Webhooks;
let cookie: string;
let workspace: string;

function build(options: { secretBox?: boolean; payloadDays?: number } = {}) {
  hooks = {
    db: database.db,
    secretBox: options.secretBox === false ? undefined : secretBox(randomBytes(32)),
    allowPrivate: true,
    payloadDays: options.payloadDays,
  };
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => ({
      id: "d",
      model: "grayson-1",
      answers: { hold: { type: "noul", value: false, probability: 0.1 } },
      usage: { input_tokens: 1 },
    }),
    now: () => clock,
    webhooks: hooks,
    presets: loadPresets(new URL("../../../templates", import.meta.url).pathname),
  });
}

const call = async (method: string, path: string, body?: unknown, as = cookie) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: as,
      ...(path.startsWith("/v1") ? { "X-Kairos-Workspace": workspace } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

async function signup(email: string) {
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse", name: "Test" }),
  });
  const data = (await response.json()) as any;
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!,
    workspace: data.workspaces[0].id as string,
    user: data.user.id as string,
  };
}

beforeEach(async () => {
  await database.reset();
  clock = START;
  build();
  ({ cookie, workspace } = await signup("owner@example.com"));
});

const sources = () => `/app/workspaces/${workspace}/webhooks`;

/** The mapping of the design note, section 7.1. */
const mapping = {
  rules: [
    {
      name: "Payment",
      match: { type: ["payment_intent.succeeded", "payment_intent.payment_failed"] },
      event: {
        id: "$.id",
        type: "transaction",
        ts: { path: "$.created", format: "unix_seconds" },
        entities: { user: "$.data.object.metadata.user_id", stripe_customer: "$.data.object.customer" },
        universal_id: "$.data.object.id",
        status: {
          path: "$.type",
          values: { "payment_intent.succeeded": "completed", "payment_intent.payment_failed": "failed" },
        },
        properties: { amount_minor: "$.data.object.amount", currency: "$.data.object.currency" },
      },
    },
    {
      name: "Dispute",
      match: { type: "charge.dispute.created" },
      event: {
        id: "$.id",
        type: "dispute_opened",
        ts: { path: "$.created", format: "unix_seconds" },
        entities: { user: "$.data.object.metadata.user_id" },
        properties: { reason: "$.data.object.reason" },
      },
      label: { entity: "user", label: "chargeback", properties: { reason: "$.data.object.reason" } },
    },
  ],
};

const payment = (id = "evt_1", user: string | null = "user_42") => ({
  id,
  type: "payment_intent.succeeded",
  created: START.getTime() / 1000 - 60,
  data: {
    object: { id: "pi_9", amount: 9500, currency: "usd", customer: "cus_N", metadata: user ? { user_id: user } : {} },
  },
});

const stripeHeader = (raw: string, secret = STRIPE_SECRET, t = Math.floor(clock.getTime() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

async function createSource(extra: Record<string, unknown> = {}) {
  const created = await call("POST", sources(), {
    direction: "in",
    name: "Stripe production",
    verification: { scheme: "stripe" },
    secret: STRIPE_SECRET,
    mapping,
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body as { webhook: any; token: string; path: string };
}

/** A delivery as a provider sends it: raw bytes, and its headers. */
async function deliver(
  path: string,
  body: unknown,
  headers: (raw: string) => Record<string, string> = (raw) => ({ "Stripe-Signature": stripeHeader(raw) }),
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const response = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers(raw) },
    body: raw,
  });
  return { status: response.status, body: (await response.json()) as any };
}

const log = async (id: string) => (await call("GET", `${sources()}/${id}/deliveries`)).body.deliveries as any[];
const events = async () =>
  (
    await database.db.execute<Record<string, any>>(
      sql`SELECT external_id AS id, workspace_id, environment_id, type, entities, properties, universal_id, status FROM events ORDER BY external_id`,
    )
  ).rows as any[];

describe("sources", () => {
  it("returns the URL token once, and never a secret", async () => {
    const { webhook, token, path } = await createSource();
    expect(token).toMatch(/^whk_/);
    expect(path).toBe(`/v1/webhooks/${token}`);
    expect(webhook).toMatchObject({
      direction: "in",
      name: "Stripe production",
      verification: { scheme: "stripe" },
      preset: null,
      token_hint: `${token.slice(0, 8)}…${token.slice(-4)}`,
    });
    const shown = JSON.stringify((await call("GET", `${sources()}/${webhook.id}`)).body);
    expect(shown).not.toContain(token);
    expect(shown).not.toContain(STRIPE_SECRET);
    expect((await call("GET", `${sources()}?direction=in`)).body.webhooks).toHaveLength(1);
  });

  it("says what is wrong with a source", async () => {
    const bad = (body: Record<string, unknown>) =>
      call("POST", sources(), {
        direction: "in",
        name: "x",
        verification: { scheme: "stripe" },
        secret: "s",
        mapping,
        ...body,
      });
    expect((await bad({ verification: { scheme: "rot13" } })).body.error.message).toContain("verification.scheme");
    expect((await bad({ verification: { scheme: "hmac" } })).body.error.message).toContain("verification.header");
    expect((await bad({ mapping: { rules: [] } })).body.error.message).toContain("at least one rule");
    expect((await bad({ secret: undefined })).body.error.message).toContain("signing secret");
    const setting = {
      rules: [{ event: { id: "$.id", type: "kyc", entities: { user: "$.u" }, set: { user: { kyc: "$.r" } } } }],
    };
    expect(
      (await bad({ verification: { scheme: "none" }, secret: undefined, mapping: setting })).body.error.message,
    ).toContain("only a source that verifies a signature");
    expect((await bad({ mapping: setting })).status).toBe(200);
  });

  it("needs the admin role, and hides other workspaces", async () => {
    const other = await signup("other@example.com");
    expect(
      (
        await call(
          "POST",
          sources(),
          { direction: "in", name: "x", verification: { scheme: "none" }, mapping },
          other.cookie,
        )
      ).status,
    ).toBe(404);
    await database.db.insert(memberships).values({
      id: `mem_${other.user}`,
      workspaceId: workspace,
      userId: other.user,
      role: "member",
      created: START,
      updated: START,
    });
    expect((await call("GET", sources(), undefined, other.cookie)).status).toBe(403);
  });

  it("needs the encryption key only for a scheme with a secret", async () => {
    build({ secretBox: false });
    expect(
      (
        await call("POST", sources(), {
          direction: "in",
          name: "x",
          verification: { scheme: "stripe" },
          secret: "s",
          mapping,
        })
      ).body.error.message,
    ).toContain("KAIROS_ENCRYPTION_KEY");
    expect(
      (await call("POST", sources(), { direction: "in", name: "x", verification: { scheme: "none" }, mapping })).status,
    ).toBe(200);
  });
});

describe("receiving", () => {
  it("stores a verified payment as an event of the source's workspace, once", async () => {
    const { webhook, path } = await createSource();
    expect(await deliver(path, payment())).toEqual({ status: 200, body: { status: "stored" } });
    expect(await events()).toEqual([
      {
        id: `${webhook.id}:evt_1`,
        workspace_id: workspace,
        environment_id: (await new EnvironmentsService(database.db, { workspaceId: workspace }).findByIdOrProduction())!
          .id,
        type: "transaction",
        entities: { user: "user_42", stripe_customer: "cus_N" },
        properties: { amount_minor: 9500, currency: "usd" },
        universal_id: "pi_9",
        status: "completed",
      },
    ]);
    // The provider sends it again: nothing more is stored.
    expect(await deliver(path, payment())).toEqual({ status: 200, body: { status: "duplicate" } });
    expect(await events()).toHaveLength(1);
    const both = await log(webhook.id);
    const first = both.find((d) => d.status === "stored")!;
    expect(first).toMatchObject({ type: "payment_intent.succeeded", external_id: "evt_1" });
    expect(both.map((d) => d.status).sort()).toEqual(["duplicate", "stored"]);
    const detail = (await call("GET", `${sources()}/${webhook.id}/deliveries/${first.id}`)).body;
    expect(detail.result).toEqual({ events: 1, duplicates: 0, labels: 0, event_ids: [`${webhook.id}:evt_1`] });
    expect(detail.payload).toEqual(payment());
    expect(detail.headers).not.toHaveProperty("stripe-signature");
  });

  it("answers each situation as the design says, and records it", async () => {
    const { webhook, path, token } = await createSource();
    expect((await deliver(path, { id: "evt_x", type: "customer.updated" })).body).toEqual({ status: "ignored" });
    const nobody = payment("evt_2", null);
    nobody.data.object.customer = null as never;
    expect((await deliver(path, nobody)).body).toEqual({ status: "no_entity" });
    expect((await deliver(path, { ...payment("evt_3"), created: "soon" })).body).toEqual({ status: "failed" });
    expect((await deliver(path, payment("evt_4"), () => ({ "Stripe-Signature": "t=1,v1=00" }))).status).toBe(401);
    expect((await deliver(path, payment("evt_5"), () => ({}))).status).toBe(401);
    expect((await deliver(path, "{not json", (raw) => ({ "Stripe-Signature": stripeHeader(raw) }))).status).toBe(400);
    expect((await deliver(path, { big: "x".repeat(1024 * 1024) })).status).toBe(413);
    expect((await deliver("/v1/webhooks/whk_unknown", payment())).status).toBe(404);
    // Every delivery here has the same time, so the log's order says nothing: compare without it.
    const statuses = (await log(webhook.id)).map((d) => d.status).sort();
    expect(statuses).toEqual(["failed", "ignored", "no_entity", "rejected", "rejected", "rejected", "rejected"]);
    const rejected = (await log(webhook.id)).filter((d) => d.status === "rejected");
    for (const d of rejected)
      expect((await call("GET", `${sources()}/${webhook.id}/deliveries/${d.id}`)).body.payload).toBeNull();
    expect(rejected.map((d) => d.problem)).toEqual(
      expect.arrayContaining(["Verification failed: no Stripe-Signature header", "The body is not JSON"]),
    );

    await call("PATCH", `${sources()}/${webhook.id}`, { enabled: false });
    expect((await deliver(path, payment("evt_6"))).status).toBe(404);
    expect(token).toBeTruthy();
    expect(await events()).toHaveLength(0);
  });

  it("checks the signature on the raw bytes, with any of two secrets, inside 5 minutes", async () => {
    const { webhook, path } = await createSource();
    const respaced = JSON.stringify(payment(), null, 2);
    // Signed over one text, sent as another with the same meaning: refused.
    expect(
      (await deliver(path, respaced, () => ({ "Stripe-Signature": stripeHeader(JSON.stringify(payment())) }))).status,
    ).toBe(401);
    expect(
      (
        await deliver(path, payment("evt_old"), (raw) => ({
          "Stripe-Signature": stripeHeader(raw, STRIPE_SECRET, START.getTime() / 1000 - 301),
        }))
      ).status,
    ).toBe(401);
    const second = "whsec_rotated_" + "r".repeat(20);
    expect(
      (await deliver(path, payment("evt_r"), (raw) => ({ "Stripe-Signature": stripeHeader(raw, second) }))).status,
    ).toBe(401);
    await call("PATCH", `${sources()}/${webhook.id}`, { add_secret: second });
    expect(
      (await deliver(path, payment("evt_r"), (raw) => ({ "Stripe-Signature": stripeHeader(raw, second) }))).status,
    ).toBe(200);
    expect((await deliver(path, payment("evt_s"))).status).toBe(200);
    expect((await call("GET", `${sources()}/${webhook.id}`)).body.secret_hints).toHaveLength(2);
  });

  it("verifies hmac and header schemes", async () => {
    const hmac = await createSource({
      name: "Custom",
      verification: {
        scheme: "hmac",
        header: "X-Signature",
        algorithm: "sha256",
        encoding: "base64",
        prefix: "sha256=",
      },
      secret: "shared",
    });
    const sign = (raw: string) => ({
      "X-Signature": `sha256=${createHmac("sha256", "shared").update(raw).digest("base64")}`,
    });
    expect((await deliver(hmac.path, payment("h1"), sign)).body).toEqual({ status: "stored" });
    expect((await deliver(hmac.path, payment("h2"), () => ({ "X-Signature": "sha256=wrong" }))).status).toBe(401);
    const header = await createSource({
      name: "Static",
      verification: { scheme: "header", header: "X-Token" },
      secret: "static-token",
    });
    expect((await deliver(header.path, payment("t1"), () => ({ "X-Token": "static-token" }))).status).toBe(200);
    expect((await deliver(header.path, payment("t2"), () => ({ "X-Token": "static-tokeN" }))).status).toBe(401);
    const none = await createSource({ name: "Open", verification: { scheme: "none" }, secret: undefined });
    expect((await deliver(none.path, payment("n1"), () => ({}))).status).toBe(200);
  });

  it("turns a dispute into an event and a label on the user, which the decision sees", async () => {
    const { path } = await createSource();
    await call("PUT", "/v1/actions/payout", { subject: "user", hold: "Should this payout be held?" });
    const dispute = {
      id: "evt_d",
      type: "charge.dispute.created",
      created: START.getTime() / 1000 - 30,
      data: { object: { reason: "fraudulent", metadata: { user_id: "user_42" } } },
    };
    expect((await deliver(path, dispute)).body).toEqual({ status: "stored" });
    expect((await deliver(path, dispute)).body).toEqual({ status: "duplicate" });
    const entity = (await call("GET", "/v1/entities/user/user_42")).body;
    expect(entity.labels.map((l: any) => l.label)).toEqual(["chargeback"]);
    expect(entity.events.map((e: any) => e.type)).toEqual(["dispute_opened"]);
    const decision = (
      await call("POST", "/v1/decide", { action: "payout", entities: { user: "user_42" }, properties: {} })
    ).body;
    const record = (await call("GET", `/v1/decisions/${decision.decision_id}`)).body;
    expect(JSON.stringify(record.context.recent_events)).toContain("dispute_opened");
  });

  it("does not let a source without a signature set entity properties", async () => {
    // A mapping saved while the scheme signed, then the scheme changed: the server still refuses.
    const setting = {
      rules: [{ event: { id: "$.id", type: "kyc", entities: { user: "$.u" }, set: { user: { kyc: "$.r" } } } }],
    };
    const { webhook, path } = await createSource({ mapping: setting });
    expect(
      (await call("PATCH", `${sources()}/${webhook.id}`, { verification: { scheme: "none" } })).body.error.message,
    ).toContain("only a source that verifies");
    expect((await deliver(path, { id: "k1", u: "user_7", r: "passed" })).body).toEqual({ status: "stored" });
    expect((await call("GET", "/v1/entities/user/user_7")).body.properties).toEqual({ kyc: "passed" });
  });

  it("makes a new URL and stops the old one at once", async () => {
    const { webhook, path } = await createSource();
    const fresh = (await call("POST", `${sources()}/${webhook.id}/token`)).body;
    expect(fresh.path).not.toBe(path);
    expect((await deliver(path, payment())).status).toBe(404);
    expect((await deliver(fresh.path, payment())).status).toBe(200);
  });
});

const presetOf = async (provider: string) =>
  (await call("GET", "/v1/webhook-presets")).body.presets.find((p: any) => p.provider === provider);

/** A source made from a preset, as the console makes it. */
async function fromPreset(provider: string, secret: string) {
  const preset = await presetOf(provider);
  const made = await createSource({
    name: preset.displayName,
    verification: preset.verification,
    secret,
    mapping: preset.mapping,
    preset: `${provider}@${preset.version}`,
  });
  return { ...made, preset };
}

describe("lookups and the Stripe preset", () => {
  it("lists the presets, with what a source needs", async () => {
    const { presets } = (await call("GET", "/v1/webhook-presets")).body;
    expect(presets.map((p: any) => `${p.provider}@${p.version}`)).toEqual([
      "checkout@1",
      "fingerprint@1",
      "intercom@1",
      "lithic@1",
      "marqeta@1",
      "shopify@1",
      "stripe@1",
      "sumsub@1",
      "zendesk@1",
    ]);
    const stripe = presets.find((p: any) => p.provider === "stripe");
    expect(stripe).toMatchObject({
      displayName: "Stripe",
      category: "payments",
      checked: false,
      verification: { scheme: "stripe" },
    });
    expect(stripe.samples.length).toBeGreaterThan(3);
    expect(presets.map((p: any) => p.category).sort()).toEqual([
      "commerce",
      "customer_support",
      "customer_support",
      "device_intelligence",
      "identity_verification",
      "payments",
      "payments",
      "transaction_intelligence",
      "transaction_intelligence",
    ]);
  });

  it("takes a payment, a refund and a dispute to the user who paid, and waits for a payment it has not seen", async () => {
    // After the last sample, so that every event is in the past.
    clock = new Date("2026-11-03T00:00:00Z");
    const preset = await presetOf("stripe");
    const { webhook, path } = await createSource({ name: "Stripe", mapping: preset.mapping, preset: "stripe@1" });
    const [succeeded, failed, refunded, disputed, closed] = preset.samples;

    // The dispute comes first: its payment is not known yet, so it has no user, and waits.
    expect((await deliver(path, disputed)).body).toEqual({ status: "no_entity" });
    const waiting = (await log(webhook.id))[0];
    expect(waiting.problem).toContain("no earlier event of record pi_3QaS1L2eZvKYlo2C0Tz5p7Rb names a user");

    for (const body of [succeeded, failed, refunded, closed])
      expect((await deliver(path, body)).body).toEqual({ status: "stored" });
    expect((await call("POST", `${sources()}/${webhook.id}/replay`, { status: "failed" })).body).toEqual({
      replayed: 1,
      statuses: { stored: 1 },
    });

    const user = (await call("GET", "/v1/entities/user/user_42")).body;
    expect(user.labels.map((l: any) => l.label).sort()).toEqual(["chargeback", "chargeback_lost"]);
    expect(user.events.map((e: any) => [e.type, e.status]).sort()).toEqual([
      ["dispute_closed", "dispute_lost"],
      ["dispute_opened", "disputed"],
      ["payment", "completed"],
      ["payment", "failed"],
      ["refund", "refunded"],
    ]);
    const record = (await call("GET", "/v1/records/pi_3QaS1L2eZvKYlo2C0Tz5p7Rb")).body;
    expect(record.stages.map((s: any) => s.status)).toEqual(["completed", "refunded", "disputed", "dispute_lost"]);
    const failedPayment = user.events.find((e: any) => e.status === "failed");
    expect(failedPayment.properties).toMatchObject({
      amount_minor: 120000,
      decline_code: "stolen_card",
      failure_code: "card_declined",
    });
  });

  it("finds a user by a property you stored on it", async () => {
    const byCustomer = {
      rules: [
        {
          event: {
            id: "$.id",
            type: "payment",
            entities: { user: { lookup: { property: "stripe_customer_id", value: "$.customer" } } },
          },
          label: { entity: "user", label: "reviewed" },
        },
      ],
    };
    const { webhook, path } = await createSource({ mapping: byCustomer });
    expect((await deliver(path, { id: "p1", customer: "cus_A" })).body).toEqual({ status: "no_entity" });
    await call("PUT", "/v1/objects", {
      batch: [{ type: "user", id: "user_7", properties: { stripe_customer_id: "CUS_A" } }],
    });
    expect((await deliver(path, { id: "p2", customer: "cus_A" })).body).toEqual({ status: "stored" });
    expect((await events()).map((e) => e.entities)).toEqual([{ user: "user_7" }]);
    expect((await call("GET", "/v1/entities/user/user_7")).body.labels.map((l: any) => l.label)).toEqual(["reviewed"]);
    // Two users with the same id at the provider: which one is not known, so neither.
    await call("PUT", "/v1/objects", {
      batch: [{ type: "user", id: "user_8", properties: { stripe_customer_id: "cus_a" } }],
    });
    expect((await deliver(path, { id: "p3", customer: "cus_A" })).body).toEqual({ status: "no_entity" });
    expect((await log(webhook.id)).find((d) => d.status === "no_entity" && d.external_id === "p3")?.problem).toContain(
      "more than one user",
    );
  });

  it("checks a lookup when the mapping is saved", async () => {
    const bad = {
      rules: [
        { event: { id: "$.id", type: "t", entities: { user: { lookup: { property: "has space", value: "$.c" } } } } },
      ],
    };
    expect(
      (await call("POST", sources(), { direction: "in", name: "x", verification: { scheme: "none" }, mapping: bad }))
        .body.error.message,
    ).toContain("lookup.property");
  });
});

describe("replay, preview and retention", () => {
  it("runs failed deliveries again after the mapping is corrected, and stores nothing twice", async () => {
    const wrong = {
      rules: [
        {
          match: { type: "payment_intent.succeeded" },
          event: { id: "$.id", type: "transaction", entities: { user: "$.data.object.metadata.customer_ref" } },
        },
      ],
    };
    const { webhook, path } = await createSource({ mapping: wrong });
    await deliver(path, payment("evt_1"));
    await deliver(path, payment("evt_2"));
    expect((await log(webhook.id)).map((d) => d.status)).toEqual(["no_entity", "no_entity"]);
    await call("PATCH", `${sources()}/${webhook.id}`, { mapping });
    expect((await call("POST", `${sources()}/${webhook.id}/replay`, { status: "failed" })).body).toEqual({
      replayed: 2,
      statuses: { stored: 2 },
    });
    expect(await events()).toHaveLength(2);
    expect((await log(webhook.id)).map((d) => [d.status, d.attempts])).toEqual([
      ["stored", 2],
      ["stored", 2],
    ]);
    const one = (await log(webhook.id))[0];
    expect((await call("POST", `${sources()}/${webhook.id}/replay`, { delivery: one.id })).body.statuses).toEqual({
      duplicate: 1,
    });
    expect(await events()).toHaveLength(2);
  });

  it("previews a mapping on a payload, storing nothing", async () => {
    const preview = (await call("POST", `${sources()}/preview`, { mapping, body: payment() })).body;
    expect(preview).toMatchObject({
      outcome: "mapped",
      matched: ["Payment"],
      events: [{ id: "evt_1", type: "transaction" }],
    });
    expect((await call("POST", `${sources()}/preview`, { mapping: { rules: [] }, body: {} })).body.outcome).toBe(
      "invalid",
    );
    expect(await events()).toHaveLength(0);
  });

  it("drops payloads after the retention period, and keeps the rows", async () => {
    const { webhook, path } = await createSource();
    await deliver(path, payment());
    await WebhookDeliveriesService.cleanup(database.db, new Date(START.getTime() + 6 * 86_400_000), 30);
    expect((await database.db.select().from(webhookDeliveries))[0]!.payload).not.toBeNull();
    await WebhookDeliveriesService.cleanup(database.db, new Date(START.getTime() + 8 * 86_400_000), 30);
    const [row] = await database.db.select().from(webhookDeliveries);
    expect(row).toMatchObject({ payload: null, status: "stored" });
    expect(await log(webhook.id)).toHaveLength(1);
  });

  it("keeps no payload when retention is 0", async () => {
    build({ payloadDays: 0 });
    const { path } = await createSource();
    await deliver(path, payment());
    expect((await database.db.select().from(webhookDeliveries))[0]!.payload).toBeNull();
  });
});

describe("the provider templates", () => {
  const hmac = (algorithm: string, secret: string, raw: string) =>
    createHmac(algorithm, secret).update(raw).digest("hex");

  it("Fingerprint: an identification goes to the user, the device and the IP", async () => {
    clock = new Date("2026-10-16T00:00:00Z");
    const { path, preset } = await fromPreset("fingerprint", "fp-signing-key");
    const signed = (raw: string) => ({ "FPJS-Event-Signature": `v1=${hmac("sha256", "fp-signing-key", raw)}` });
    for (const body of preset.samples) expect((await deliver(path, body, signed)).body).toEqual({ status: "stored" });
    expect(
      (
        await deliver(path, preset.samples[0], (raw) => ({
          "FPJS-Event-Signature": `v1=${hmac("sha256", "wrong", raw)}`,
        }))
      ).status,
    ).toBe(401);

    const risky = (await events()).find((e) => e.entities.user === "user_77");
    expect(risky).toMatchObject({
      type: "device_identified",
      entities: { user: "user_77", device: "0jnGMkPYXX37DqVa4ZIO", ip: "185.220.101.4" },
    });
    expect(risky.properties).toMatchObject({
      action: "signup",
      vpn: true,
      proxy_type: "data_center",
      tor: true,
      tampering: true,
      anti_detect_browser: true,
      ip_country: "DE",
      distinct_ips_24h: 31,
      users_on_device_24h: 14,
    });
    const device = (await call("GET", "/v1/entities/device/Ibk1527CUFmcnjLwIs4A9")).body;
    expect(device.properties).toMatchObject({ first_seen_at: 1789473600000 });
  });

  it("Checkout.com: payments, a refund and a dispute go to the user who paid", async () => {
    // After the last sample, so that every event is in the past.
    clock = new Date("2026-11-06T00:00:00Z");
    const { webhook, path, preset } = await fromPreset("checkout", "cko-key");
    const signed = (raw: string) => ({ "Cko-Signature": hmac("sha256", "cko-key", raw) });
    const [approved, declined, captured, refunded, disputed, lost] = preset.samples;
    // The dispute first: its payment is not known yet, so it waits for a replay.
    expect((await deliver(path, disputed, signed)).body).toEqual({ status: "no_entity" });
    for (const body of [approved, declined, captured, refunded, lost])
      expect((await deliver(path, body, signed)).body).toEqual({ status: "stored" });
    expect((await call("POST", `${sources()}/${webhook.id}/replay`, { status: "failed" })).body).toEqual({
      replayed: 1,
      statuses: { stored: 1 },
    });

    const user = (await call("GET", "/v1/entities/user/user_42")).body;
    expect(user.labels.map((l: any) => l.label).sort()).toEqual(["chargeback", "chargeback_lost"]);
    const record = (await call("GET", "/v1/records/pay_griq7wyqkggu7mnk7ecm6ysrl4")).body;
    expect(record.stages.map((s: any) => s.status)).toEqual([
      "approved",
      "completed",
      "refunded",
      "disputed",
      "dispute_lost",
    ]);
    const decline = user.events.find((e: any) => e.status === "declined");
    expect(decline.properties).toMatchObject({
      amount_minor: 120000,
      response_summary: "Suspected fraud",
      risk_flagged: true,
      risk_score: 87,
      issuer_country: "NG",
      avs_check: "N",
    });
    const first = user.events.find((e: any) => e.status === "approved");
    expect(first.properties).toMatchObject({ wallet: "applepay", three_ds_challenged: false, three_ds_eci: "05" });
    expect((await events()).find((e) => e.status === "approved").entities).toMatchObject({
      card: "E4AEAAB4AC2F55761E20D5DEDEA3B5AD6DFD5511CEFDA8A922AB78DBF5F8E0AC",
      ip: "81.2.69.160",
      checkout_customer: "cus_m3cixs4slzcelfjmdcodlgyvkq",
    });
  });

  it("Intercom: a new conversation and a reply, with their text", async () => {
    clock = new Date("2026-10-16T00:00:00Z");
    const { path, preset } = await fromPreset("intercom", "client-secret");
    const signed = (raw: string) => ({ "X-Hub-Signature": `sha1=${hmac("sha1", "client-secret", raw)}` });
    for (const body of preset.samples) expect((await deliver(path, body, signed)).body).toEqual({ status: "stored" });
    const user = (await call("GET", "/v1/entities/user/user_42")).body;
    expect(user.events.map((e: any) => [e.type, e.status]).sort()).toEqual([
      ["support_message", "opened"],
      ["support_message", "replied"],
    ]);
    expect(user.events.find((e: any) => e.status === "replied").properties.message).toContain("block my card");
    expect((await events())[0].entities).toMatchObject({ intercom_contact: "66f2a1b3c4d5e6f7a8b9c0d1" });
  });

  it("Lithic: card transactions go to the user whose Lithic account it is", async () => {
    const secret = `whsec_${randomBytes(24).toString("base64")}`;
    const { path, preset } = await fromPreset("lithic", secret);
    const signed = (id: string) => (raw: string) => {
      const time = String(Math.floor(clock.getTime() / 1000));
      const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(`${id}.${time}.${raw}`)
        .digest("base64");
      return { "webhook-id": id, "webhook-timestamp": time, "webhook-signature": `v1,${signature}` };
    };
    await call("PUT", "/v1/objects", {
      batch: [
        { type: "user", id: "user_42", properties: { lithic_account_token: "bd5e5649-1be8-4117-9bc5-3268258d1417" } },
      ],
    });
    for (const [i, body] of preset.samples.entries())
      expect((await deliver(path, body, signed(`msg_${i}`))).body).toEqual({ status: "stored" });
    expect(
      (await deliver(path, preset.samples[0], (raw) => ({ ...signed("msg_x")(raw), "webhook-id": "msg_y" }))).status,
    ).toBe(401);

    const user = (await call("GET", "/v1/entities/user/user_42")).body;
    expect(user.events.map((e: any) => e.status).sort()).toEqual(["declined", "pending"]);
    const declined = user.events.find((e: any) => e.status === "declined");
    expect(declined.properties).toMatchObject({
      result: "SUSPECTED_FRAUD",
      mcc: "5815",
      merchant_country: "NLD",
      card_present: "NOT_PRESENT",
      network_risk_score: 910,
      three_ds_result: "DECLINE",
      latest_event: "AUTHORIZATION",
      latest_event_amount_minor: 125000,
    });
    expect((await events()).map((e) => e.id).sort()).toEqual(
      expect.arrayContaining([expect.stringMatching(/:5f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f$/)]),
    );
  });

  it("Zendesk: links the Zendesk user to your user, then follows the ticket", async () => {
    clock = new Date("2026-10-16T00:00:00Z");
    const { path, preset } = await fromPreset("zendesk", "zd-signing-secret");
    const signed = (raw: string) => {
      const time = clock.toISOString();
      return {
        "X-Zendesk-Webhook-Signature": createHmac("sha256", "zd-signing-secret")
          .update(time + raw)
          .digest("base64"),
        "X-Zendesk-Webhook-Signature-Timestamp": time,
      };
    };
    for (const body of preset.samples) expect((await deliver(path, body, signed)).body).toEqual({ status: "stored" });
    expect(
      (
        await deliver(path, preset.samples[1], (raw) => ({
          ...signed(raw),
          "X-Zendesk-Webhook-Signature-Timestamp": "2026-10-15T23:50:00Z",
        }))
      ).status,
    ).toBe(401);

    const user = (await call("GET", "/v1/entities/user/user_42")).body;
    expect(user.properties).toMatchObject({ zendesk_user_id: "6596848315901" });
    const record = (await call("GET", "/v1/records/5158")).body;
    expect(record.stages.map((s: any) => s.status)).toEqual(["opened", "replied", "solved"]);
    expect(user.events.find((e: any) => e.status === "replied").properties.message).toContain("block my card");

    // A message from an agent is not the user's, and a requester with no link is stored on the Zendesk user only.
    const agent = structuredClone(preset.samples[2]);
    agent.id = "agent-comment";
    agent.event.comment.author = { id: "7489421176190", is_staff: true, name: "Agent" };
    expect((await deliver(path, agent, signed)).body).toEqual({ status: "ignored" });
    const stranger = structuredClone(preset.samples[1]);
    stranger.id = "other-ticket";
    stranger.detail.requester_id = "999";
    expect((await deliver(path, stranger, signed)).body).toEqual({ status: "stored" });
    expect((await events()).find((e) => e.id.endsWith(":other-ticket")).entities).toEqual({ zendesk_user: "999" });
  });

  it("Marqeta: a batch of card transactions goes to the user whose Marqeta user it is", async () => {
    clock = new Date("2026-10-16T00:00:00Z");
    const { path, preset } = await fromPreset("marqeta", "marqeta-secret-of-twenty-plus");
    const signed = (raw: string) => ({
      "X-Marqeta-Signature": hmac("sha256", "marqeta-secret-of-twenty-plus", raw),
      Authorization: "Basic dXNlcjpwYXNz",
    });
    await call("PUT", "/v1/objects", {
      batch: [
        { type: "user", id: "user_42", properties: { marqeta_user_token: "99f323d4-298f-4b0c-93b1-19b2d9921eb8" } },
      ],
    });
    const [authorized, declined, batch, chargeback, ping] = preset.samples;
    for (const body of [authorized, declined, batch, chargeback])
      expect((await deliver(path, body, signed)).body).toEqual({ status: "stored" });
    // Marqeta's health check matches no rule.
    expect((await deliver(path, ping, signed)).body).toEqual({ status: "ignored" });

    const record = (await call("GET", "/v1/records/36d04781-d34f-4e0c-b895-2f1af976b565")).body;
    expect(record.stages.map((s: any) => s.status)).toEqual(["pending", "completed", "refunded"]);
    const user = (await call("GET", "/v1/entities/user/user_42")).body;
    expect(user.labels.map((l: any) => l.label)).toEqual(["cardholder_dispute"]);
    const decline = user.events.find((e: any) => e.status === "declined");
    expect(decline.properties).toMatchObject({
      amount: 1250,
      response_memo: "Insufficient funds",
      mcc: "5815",
      merchant_country: "NLD",
      card_present: false,
      transaction_risk_score: 91,
      three_ds_result: "not_verified",
    });
    expect(decline.entities).toMatchObject({
      user: "user_42",
      marqeta_user: "99f323d4-298f-4b0c-93b1-19b2d9921eb8",
      card: "02cc766c-24a5-4c3b-adcf-0e5e27b09329",
    });
  });

  it("Shopify: orders, a refund and a chargeback go to the customer who ordered", async () => {
    // After the last sample, so that every event is in the past.
    clock = new Date("2026-11-06T00:00:00Z");
    const { webhook, path, preset } = await fromPreset("shopify", "shopify-signing-key");
    const signed =
      (i: number, secret = "shopify-signing-key") =>
      (raw: string) => ({
        ...preset.sampleHeaders[i],
        "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(raw).digest("base64"),
      });
    const [created, paid, refunded, disputed, lost, risky, canceled] = preset.samples;
    // The dispute first: its order is not known yet, so it waits for a replay.
    expect((await deliver(path, disputed, signed(3))).body).toEqual({ status: "no_entity" });
    for (const [i, body] of [created, paid, refunded, disputed, lost, risky, canceled].entries())
      if (i !== 3) expect((await deliver(path, body, signed(i))).body).toEqual({ status: "stored" });
    expect((await call("POST", `${sources()}/${webhook.id}/replay`, { status: "failed" })).body).toEqual({
      replayed: 1,
      statuses: { stored: 1 },
    });
    // A retry has the same X-Shopify-Webhook-Id, and stores nothing twice.
    expect((await deliver(path, created, signed(0))).body).toEqual({ status: "duplicate" });
    expect((await deliver(path, created, signed(0, "wrong"))).status).toBe(401);
    expect(
      (await deliver(path, created, (raw) => ({ ...signed(0)(raw), "X-Shopify-Topic": "orders/updated" }))).body,
    ).toEqual({ status: "ignored" });

    const user = (await call("GET", "/v1/entities/user/7389154082937")).body;
    expect(user.labels.map((l: any) => l.label).sort()).toEqual(["chargeback", "chargeback_lost"]);
    const record = (await call("GET", "/v1/records/5690451296477")).body;
    expect(record.stages.map((s: any) => s.status)).toEqual([
      "created",
      "paid",
      "refunded",
      "disputed",
      "dispute_lost",
    ]);
    const order = user.events.find((e: any) => e.status === "created");
    expect(order.properties).toMatchObject({
      order_name: "#1023",
      amount: 404.95,
      currency: "USD",
      gateway: "shopify_payments",
      billing_country: "US",
      customer_verified_email: true,
      shop: "example-store.myshopify.com",
    });
    expect(user.events.find((e: any) => e.status === "refunded").properties).toMatchObject({ amount: 89.99 });
    expect(user.events.find((e: any) => e.status === "disputed").properties).toMatchObject({
      dispute_type: "chargeback",
      reason: "fraudulent",
      amount: 315,
    });

    const other = (await call("GET", "/v1/entities/user/7389154099321")).body;
    expect(other.events.map((e: any) => e.status).sort()).toEqual(["canceled", "created"]);
    expect(other.events.find((e: any) => e.status === "canceled").properties).toMatchObject({
      cancel_reason: "fraud",
      financial_status: "voided",
      shipping_country: "NG",
    });
    expect(other.events.find((e: any) => e.status === "created").properties).toMatchObject({
      discount_code: "WELCOME20",
      amount: 974.25,
    });
    expect((await events()).find((e) => e.status === "canceled").entities).toEqual({
      user: "7389154099321",
      ip: "185.220.101.4",
    });
  });

  it("Sumsub: follows each identity check, and puts the result on your user", async () => {
    clock = new Date("2026-10-16T00:00:00Z");
    const { path, preset } = await fromPreset("sumsub", "sumsub-secret-key");
    const signed = (raw: string) => ({
      "X-Payload-Digest": hmac("sha256", "sumsub-secret-key", raw),
      "X-Payload-Digest-Alg": "HMAC_SHA256_HEX",
    });
    for (const body of preset.samples) expect((await deliver(path, body, signed)).body).toEqual({ status: "stored" });
    // Sumsub sends no event id: the applicant, the type and the time make one, so a retry stores nothing.
    expect((await deliver(path, preset.samples[3], signed)).body).toEqual({ status: "duplicate" });
    expect(
      (await deliver(path, preset.samples[3], (raw) => ({ ...signed(raw), "X-Payload-Digest": "0".repeat(64) })))
        .status,
    ).toBe(401);
    // A pending stage and its review share a correlationId; both are kept.
    expect(await events()).toHaveLength(preset.samples.length);

    const user = (await call("GET", "/v1/entities/user/user_42")).body;
    expect(user.properties).toMatchObject({ kyc_status: "approved", kyc_level: "id-and-liveness" });
    expect(user.labels).toEqual([]);
    const record = (await call("GET", "/v1/records/6a1f3c2e9b7d4e0012a4c5f1")).body;
    expect(record.stages.map((s: any) => s.status)).toEqual([
      "started",
      "pending",
      "resubmission_requested",
      "approved",
    ]);

    const rejected = (await call("GET", "/v1/entities/user/user_77")).body;
    expect(rejected.properties).toMatchObject({ kyc_status: "rejected" });
    expect(rejected.labels.map((l: any) => l.label)).toEqual(["kyc_rejected"]);
    const result = (await events()).find((e) => e.status === "rejected");
    expect(result.entities).toEqual({ user: "user_77", sumsub_applicant: "6a1f40d79b7d4e0012a4d6e3" });
    expect(result.properties).toMatchObject({ reject_type: "FINAL", reject_labels: ["FORGERY", "SELFIE_MISMATCH"] });
  });
});
