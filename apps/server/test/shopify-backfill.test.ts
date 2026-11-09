import { createHmac, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Webhooks } from "../src/context";
import { createJobs, type Jobs } from "../src/platform/jobs/worker";
import { secretBox } from "../src/platform/secrets";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { loadPresets, shopifyBackfillKind, type ShopifyDispute, type ShopifyOrder } from "../src/modules/webhooks/libs";
import { JobsService } from "../src/services/job.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const SHOP = "example-store.myshopify.com";
const ALL_SCOPES = ["read_orders", "read_all_orders", "read_customers", "read_shopify_payments_disputes"];

let clock: Date;
let app: ReturnType<typeof createApp>;
let runner: Jobs;
let cookie: string;
let workspace: string;

/** The fake shop: what its Admin API answers. */
let shop: {
  scopes: string[];
  orders: ShopifyOrder[];
  disputes: ShopifyDispute[];
  refuse: boolean;
  calls: { url: string; body: string }[];
};

const money = (amount: string) => ({ shopMoney: { amount } });

/** The orders of the preset's samples, as the GraphQL API gives them. */
const ada: ShopifyOrder = {
  legacyResourceId: "5690451296477",
  name: "#1023",
  createdAt: "2026-10-14T12:00:04Z",
  cancelledAt: null,
  cancelReason: null,
  test: false,
  clientIp: "81.2.69.160",
  totalPriceSet: money("404.95"),
  subtotalPriceSet: money("394.95"),
  totalDiscountsSet: money("0.00"),
  currencyCode: "USD",
  displayFinancialStatus: "PARTIALLY_REFUNDED",
  displayFulfillmentStatus: "UNFULFILLED",
  sourceName: "web",
  paymentGatewayNames: ["shopify_payments"],
  discountCodes: [],
  customer: {
    legacyResourceId: "7389154082937",
    createdAt: "2025-03-02T15:12:00Z",
    verifiedEmail: true,
    state: "ENABLED",
  },
  billingAddress: { countryCodeV2: "US", zip: "40003" },
  shippingAddress: { countryCodeV2: "US", zip: "40003" },
  customerJourneySummary: {
    firstVisit: {
      landingPage: "https://example-store.myshopify.com/products/aviator-sunglasses",
      referrerUrl: "https://www.google.com/",
    },
  },
  transactions: [
    {
      kind: "AUTHORIZATION",
      status: "SUCCESS",
      processedAt: "2026-10-14T12:00:04Z",
      createdAt: "2026-10-14T12:00:04Z",
    },
    { kind: "CAPTURE", status: "SUCCESS", processedAt: "2026-10-14T12:01:10Z", createdAt: "2026-10-14T12:01:10Z" },
    { kind: "REFUND", status: "SUCCESS", processedAt: "2026-10-16T13:30:00Z", createdAt: "2026-10-16T13:30:00Z" },
  ],
  refunds: [
    {
      legacyResourceId: "935412345678",
      createdAt: "2026-10-16T13:30:00Z",
      note: "Things were damaged",
      transactions: { nodes: [{ gateway: "shopify_payments", status: "SUCCESS", amountSet: money("89.99") }] },
    },
  ],
};

const quick: ShopifyOrder = {
  ...ada,
  legacyResourceId: "5690451329245",
  name: "#1024",
  createdAt: "2026-10-15T06:14:40Z",
  cancelledAt: "2026-10-15T07:02:00Z",
  cancelReason: "FRAUD",
  clientIp: "185.220.101.4",
  totalPriceSet: money("974.25"),
  subtotalPriceSet: money("1299.00"),
  totalDiscountsSet: money("324.75"),
  displayFinancialStatus: "VOIDED",
  discountCodes: ["WELCOME20"],
  customer: {
    legacyResourceId: "7389154099321",
    createdAt: "2026-10-15T06:11:02Z",
    verifiedEmail: false,
    state: "DISABLED",
  },
  billingAddress: { countryCodeV2: "GB", zip: "EC1A 1BB" },
  shippingAddress: { countryCodeV2: "NG", zip: "100001" },
  customerJourneySummary: null,
  transactions: [
    {
      kind: "AUTHORIZATION",
      status: "SUCCESS",
      processedAt: "2026-10-15T06:14:40Z",
      createdAt: "2026-10-15T06:14:40Z",
    },
    { kind: "VOID", status: "SUCCESS", processedAt: "2026-10-15T07:02:00Z", createdAt: "2026-10-15T07:02:00Z" },
  ],
  refunds: [],
};

const chargeback: ShopifyDispute = {
  legacyResourceId: "11234567890",
  type: "CHARGEBACK",
  status: "LOST",
  initiatedAt: "2026-10-20T12:00:00Z",
  finalizedOn: "2026-11-05T13:00:00Z",
  evidenceDueBy: "2026-11-01T23:00:00Z",
  amount: { amount: "315.00", currencyCode: "USD" },
  reasonDetails: { reason: "FRAUDULENT", networkReasonCode: "10.4" },
  order: { legacyResourceId: "5690451296477" },
};

/** One node a page, so that the import follows the cursor. */
function page<T>(nodes: T[], after: string | null) {
  const i = after ? Number(after) : 0;
  return { pageInfo: { hasNextPage: i + 1 < nodes.length, endCursor: String(i + 1) }, nodes: nodes.slice(i, i + 1) };
}

const fakeShopify: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = String(init?.body ?? "");
  shop.calls.push({ url, body });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (url === `https://${SHOP}/admin/oauth/access_token`)
    return shop.refuse
      ? json({ error: "invalid_client" }, 400)
      : json({ access_token: "shpca_fresh", expires_in: 86399 });
  if (url !== `https://${SHOP}/admin/api/2026-10/graphql.json`) return json({}, 404);
  if (shop.refuse) return json({ errors: "[API] Invalid API key or access token" }, 401);
  const { query, variables } = JSON.parse(body);
  if (query.includes("currentAppInstallation"))
    return json({ data: { currentAppInstallation: { accessScopes: shop.scopes.map((handle) => ({ handle })) } } });
  if (query.includes("orders(")) return json({ data: { orders: page(shop.orders, variables.after) } });
  if (query.includes("disputes(")) return json({ data: { disputes: page(shop.disputes, variables.after) } });
  return json({ errors: [{ message: "unknown query" }] });
};

function build() {
  const repos = createRepositories(database.db);
  const hooks: Webhooks = { db: database.db, secretBox: secretBox(randomBytes(32)), allowPrivate: true };
  runner = createJobs({
    repo: repos.jobs,
    kinds: [shopifyBackfillKind({ repos, hooks, jobs: repos.jobs, now: () => clock, fetch: fakeShopify })],
    now: () => clock,
    random: () => 0.5,
    log: () => {},
  });
  // The admin starts an import only on a server that runs jobs.
  hooks.worker = { drain: runner.drain, wake: () => {}, sendNow: async () => ({ delivered: false, body: "", ms: 0 }) };
  app = createApp({
    repos,
    accounts: tenancyRepository(database.db),
    environments: environmentsRepository(database.db),
    decider: async () => ({ id: "d", model: "grayson-1", answers: {}, usage: { input_tokens: 1 } }),
    now: () => clock,
    webhooks: hooks,
    fetch: fakeShopify,
    presets: loadPresets(new URL("../../../templates", import.meta.url).pathname),
  });
}

const call = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(path.startsWith("/v1") ? { "X-Kairos-Workspace": workspace } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

const sources = () => `/app/workspaces/${workspace}/webhooks`;

async function shopifySource() {
  const preset = (await call("GET", "/v1/webhook-presets")).body.presets.find((p: any) => p.provider === "shopify");
  const made = await call("POST", sources(), {
    direction: "in",
    name: "Shopify",
    verification: preset.verification,
    secret: "shopify-signing-key",
    mapping: preset.mapping,
    preset: `shopify@${preset.version}`,
  });
  expect(made.status).toBe(200);
  return { ...made.body, preset };
}

const connect = (id: string, shopify: unknown) => call("PATCH", `${sources()}/${id}`, { shopify });
const credentials = { shop: SHOP, client_id: "client-id-1", client_secret: "shpss_client_secret_1234" };

const events = async () =>
  (
    await database.db.execute<Record<string, any>>(
      sql`SELECT external_id AS id, type, status, ts, entities, properties FROM events ORDER BY ts, external_id`,
    )
  ).rows as any[];

beforeEach(async () => {
  await database.reset();
  clock = new Date("2026-11-09T12:00:00Z");
  shop = { scopes: ALL_SCOPES, orders: [ada, quick], disputes: [chargeback], refuse: false, calls: [] };
  build();
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "correct horse", name: "Test" }),
  });
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  workspace = ((await response.json()) as any).workspaces[0].id;
});

describe("connecting a shop", () => {
  it("checks the credentials and the scopes, and never returns the secret", async () => {
    const { webhook } = await shopifySource();

    shop.scopes = ["read_orders", "read_customers"];
    const lacking = await connect(webhook.id, credentials);
    expect(lacking.status).toBe(400);
    expect(lacking.body.error.message).toContain("the app lacks read_all_orders, read_shopify_payments_disputes");

    shop.scopes = ALL_SCOPES;
    shop.refuse = true;
    expect((await connect(webhook.id, credentials)).body.error.message).toContain(
      "Shopify refused the client id and secret",
    );

    shop.refuse = false;
    const connected = await connect(webhook.id, credentials);
    expect(connected.status).toBe(200);
    expect(connected.body.shopify).toEqual({ shop: SHOP, client_id: "client-id-1", secret_hint: "shpss_…1234" });
    expect(JSON.stringify(connected.body)).not.toContain("shpss_client_secret_1234");

    expect((await connect(webhook.id, { ...credentials, shop: "evil.example.com" })).body.error.message).toContain(
      "myshopify.com",
    );
    expect((await connect(webhook.id, null)).body.shopify).toBeNull();
  });

  it("is only for a Shopify source", async () => {
    const other = await call("POST", sources(), {
      direction: "in",
      name: "Other",
      verification: { scheme: "none" },
      mapping: { rules: [{ name: "Any", event: { id: "$.id", type: "x", entities: { user: "$.user" } } }] },
    });
    expect((await connect(other.body.webhook.id, credentials)).body.error.message).toContain(
      "only a source made from the Shopify preset",
    );
  });
});

describe("importing past orders", () => {
  it("stores what the webhooks would have stored, once, at the times it happened", async () => {
    const { webhook, path, preset } = await shopifySource();
    // The webhook was connected before the import: the first order is there already.
    const raw = JSON.stringify(preset.samples[0]);
    const delivered = await app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...preset.sampleHeaders[0],
        "X-Shopify-Hmac-Sha256": createHmac("sha256", "shopify-signing-key").update(raw).digest("base64"),
      },
      body: raw,
    });
    expect(await delivered.json()).toEqual({ status: "stored" });
    const live = (await events())[0];

    expect(
      (await call("POST", `${sources()}/${webhook.id}/backfill`, { since: "2026-05-09" })).body.error.message,
    ).toBe("Connect the shop first: paste the app's credentials");
    await connect(webhook.id, credentials);
    const started = await call("POST", `${sources()}/${webhook.id}/backfill`, { since: "2026-05-09" });
    expect(started.body.backfill).toMatchObject({
      status: "running",
      since: "2026-05-09T00:00:00.000Z",
      phase: "orders",
    });
    expect((await call("POST", `${sources()}/${webhook.id}/backfill`, { since: "2026-05-09" })).status).toBe(409);

    await runner.drain();

    expect((await call("GET", `${sources()}/${webhook.id}/backfill`)).body.backfill).toEqual({
      status: "done",
      since: "2026-05-09T00:00:00.000Z",
      started: clock.toISOString(),
      finished: clock.toISOString(),
      phase: "done",
      orders: 2,
      disputes: 1,
      // The first order's creation came from the webhook already.
      stored: 6,
      duplicate: 1,
      failed: 0,
      error: null,
    });
    const graphql = shop.calls.filter((c) => c.url.endsWith("graphql.json")).map((c) => JSON.parse(c.body));
    expect(graphql.filter((q) => q.query.includes("orders(")).map((q) => q.variables)).toEqual([
      { after: null, first: 25, query: "created_at:>='2026-05-09T00:00:00.000Z'" },
      { after: "1", first: 25, query: "created_at:>='2026-05-09T00:00:00.000Z'" },
    ]);

    const stored = await events();
    expect(stored.map((e) => [e.id.split(":").slice(1).join(":"), e.status, new Date(e.ts).toISOString()])).toEqual([
      ["orders/create:5690451296477", "created", "2026-10-14T12:00:05.000Z"],
      ["orders/paid:5690451296477", "paid", "2026-10-14T12:01:10.000Z"],
      ["orders/create:5690451329245", "created", "2026-10-15T06:14:40.000Z"],
      ["orders/cancelled:5690451329245", "canceled", "2026-10-15T07:02:00.000Z"],
      ["refund:935412345678", "refunded", "2026-10-16T13:30:00.000Z"],
      ["dispute:11234567890", "disputed", "2026-10-20T12:00:00.000Z"],
      ["dispute_closed:11234567890", "dispute_lost", "2026-11-05T13:00:00.000Z"],
    ]);
    // The webhook's event is the one kept.
    expect(stored[0]).toEqual(live);

    const paid = stored[1];
    expect(paid.entities).toEqual({ user: "7389154082937", ip: "81.2.69.160" });
    expect(paid.properties).toMatchObject({
      order_name: "#1023",
      amount: 404.95,
      currency: "USD",
      gateway: "shopify_payments",
      billing_country: "US",
      customer_verified_email: true,
      customer_state: "enabled",
      landing_site: "/products/aviator-sunglasses",
      shop: SHOP,
    });
    expect(stored[3].properties).toMatchObject({ cancel_reason: "fraud", discount_code: "WELCOME20", amount: 974.25 });
    expect(stored[4].properties).toMatchObject({ amount: 89.99, note: "Things were damaged" });

    const user = (await call("GET", "/v1/entities/user/7389154082937")).body;
    expect(user.labels.map((l: any) => l.label).sort()).toEqual(["chargeback", "chargeback_lost"]);

    // Running it again stores nothing twice.
    await call("POST", `${sources()}/${webhook.id}/backfill`, { since: "2026-05-09" });
    await runner.drain();
    expect((await call("GET", `${sources()}/${webhook.id}/backfill`)).body.backfill).toMatchObject({
      status: "done",
      stored: 0,
      duplicate: 7,
    });
    expect(await events()).toHaveLength(7);
  });

  it("stops with the reason when Shopify refuses the credentials", async () => {
    const { webhook } = await shopifySource();
    await connect(webhook.id, { shop: SHOP, token: "shpat_old_admin_app_token" });
    await call("POST", `${sources()}/${webhook.id}/backfill`, { since: "2026-05-09" });
    shop.refuse = true;
    await runner.drain();
    expect((await call("GET", `${sources()}/${webhook.id}/backfill`)).body.backfill).toMatchObject({
      status: "failed",
      error: "Shopify refused the access token. Check that the app is installed on the shop.",
    });
    // An admin app's token is sent as it is.
    expect(shop.calls.some((c) => c.url.endsWith("access_token"))).toBe(false);
    expect(await new JobsService(database.db).latest("webhook.shopify_backfill", `${webhook.id}:`)).toMatchObject({
      status: "dead",
      attempts: 1,
    });
  });
});
