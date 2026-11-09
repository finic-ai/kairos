export const SHOPIFY_API_VERSION = "2026-10";
export const SHOPIFY_SCOPES = ["read_orders", "read_all_orders", "read_customers", "read_shopify_payments_disputes"];

const SHOP = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/** The shop is put in a URL that the server calls, so only a myshopify.com domain is accepted. */
export function shopProblem(shop: string): string | undefined {
  return SHOP.test(shop) ? undefined : "must be the shop's myshopify.com domain, such as example-store.myshopify.com";
}

export class ShopifyError extends Error {
  constructor(
    message: string,
    /** A token that is wrong or lacks a scope: a retry cannot help. */
    readonly permanent = false,
  ) {
    super(message);
  }
}

export type ShopifyClient = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/** A token of an app made in the Shopify admin, or the client id and secret of a Dev Dashboard app. */
export type ShopifyCredentials = { token: string } | { clientId: string; clientSecret: string };

/** A Dev Dashboard app's token lasts 24 hours, so one is asked for each time it is needed. */
export async function accessToken(
  shop: string,
  credentials: ShopifyCredentials,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if ("token" in credentials) return credentials.token;
  const response = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status >= 400 && response.status < 500)
    throw new ShopifyError(
      "Shopify refused the client id and secret. Check that the app is installed on the shop, and that the app and the shop are in the same organization.",
      true,
    );
  if (!response.ok) throw new ShopifyError(`Shopify answered ${response.status}.`);
  return ((await response.json()) as { access_token: string }).access_token;
}

export function shopifyClient(shop: string, token: string, fetchFn: typeof fetch = fetch): ShopifyClient {
  return async <T>(query: string, variables: Record<string, unknown> = {}) => {
    const response = await fetchFn(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403)
      throw new ShopifyError("Shopify refused the access token. Check that the app is installed on the shop.", true);
    if (response.status === 404) throw new ShopifyError(`Shopify knows no shop ${shop}.`, true);
    if (!response.ok) throw new ShopifyError(`Shopify answered ${response.status}.`);
    const answer = (await response.json()) as {
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[];
    };
    if (answer.errors?.length) {
      const [first] = answer.errors;
      const code = first!.extensions?.code;
      throw new ShopifyError(
        code === "THROTTLED" ? "Shopify asked to slow down." : `Shopify: ${first!.message}`,
        code === "ACCESS_DENIED",
      );
    }
    return answer.data as T;
  };
}

/** The scopes that the token lacks, after checking that it works on the shop. */
export async function missingScopes(client: ShopifyClient): Promise<string[]> {
  const data = await client<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(
    "{ currentAppInstallation { accessScopes { handle } } }",
  );
  const granted = new Set(data.currentAppInstallation.accessScopes.map((s) => s.handle));
  return SHOPIFY_SCOPES.filter((s) => !granted.has(s));
}

// Each page must stay under Shopify's query cost of 1,000.
export const ORDERS_PAGE = 25;
export const DISPUTES_PAGE = 100;

const MONEY = "shopMoney { amount }";
const ADDRESS = "countryCodeV2 zip";

export const ORDERS_QUERY = `query Orders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId name createdAt cancelledAt cancelReason test clientIp
      totalPriceSet { ${MONEY} } subtotalPriceSet { ${MONEY} } totalDiscountsSet { ${MONEY} }
      currencyCode displayFinancialStatus displayFulfillmentStatus sourceName paymentGatewayNames discountCodes
      customer { legacyResourceId createdAt verifiedEmail state }
      billingAddress { ${ADDRESS} } shippingAddress { ${ADDRESS} }
      customerJourneySummary { firstVisit { landingPage referrerUrl } }
      transactions(first: 10) { kind status processedAt createdAt }
      refunds(first: 5) {
        legacyResourceId createdAt note
        transactions(first: 1) { nodes { gateway status amountSet { ${MONEY} } } }
      }
    }
  }
}`;

export const DISPUTES_QUERY = `query Disputes($first: Int!, $after: String, $query: String) {
  disputes(first: $first, after: $after, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId type status initiatedAt finalizedOn evidenceDueBy
      amount { amount currencyCode }
      reasonDetails { reason networkReasonCode }
      order { legacyResourceId }
    }
  }
}`;

type Money = { shopMoney: { amount: string } } | null;
type Address = { countryCodeV2: string | null; zip: string | null } | null;

export interface ShopifyOrder {
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  test: boolean;
  clientIp: string | null;
  totalPriceSet: Money;
  subtotalPriceSet: Money;
  totalDiscountsSet: Money;
  currencyCode: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  sourceName: string | null;
  paymentGatewayNames: string[];
  discountCodes: string[];
  customer: { legacyResourceId: string; createdAt: string; verifiedEmail: boolean; state: string } | null;
  billingAddress: Address;
  shippingAddress: Address;
  customerJourneySummary: { firstVisit: { landingPage: string | null; referrerUrl: string | null } | null } | null;
  transactions: { kind: string; status: string; processedAt: string | null; createdAt: string }[];
  refunds: {
    legacyResourceId: string;
    createdAt: string | null;
    note: string | null;
    transactions: { nodes: { gateway: string | null; status: string; amountSet: Money }[] };
  }[];
}

export interface ShopifyDispute {
  legacyResourceId: string;
  type: string;
  status: string;
  initiatedAt: string;
  finalizedOn: string | null;
  evidenceDueBy: string | null;
  amount: { amount: string; currencyCode: string };
  reasonDetails: { reason: string; networkReasonCode: string | null };
  order: { legacyResourceId: string } | null;
}

export interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

/** A webhook that Shopify would have sent at the time: its topic, its moment and its body as the REST API writes it. */
export interface PastDelivery {
  topic: string;
  at: string;
  body: Record<string, unknown>;
}

const lower = (value: string | null | undefined) => (value ? value.toLowerCase() : null);
const amount = (money: Money) => money?.shopMoney.amount ?? null;
const address = (a: Address) => (a ? { country_code: a.countryCodeV2, zip: a.zip } : null);
const FULFILLMENT: Record<string, string> = {
  FULFILLED: "fulfilled",
  PARTIALLY_FULFILLED: "partial",
  RESTOCKED: "restocked",
};
const FINAL_DISPUTE = new Set(["won", "lost", "accepted", "charge_refunded"]);

function path(url: string | null | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * The order's webhooks: created, paid and cancelled, and one for each refund. Shopify's GraphQL
 * API has no user agent or accept language, so those properties stay empty. The financial and
 * fulfillment status are the order's status now, not at the time of each webhook.
 */
export function orderDeliveries(order: ShopifyOrder): PastDelivery[] {
  const visit = order.customerJourneySummary?.firstVisit;
  const body = (at: string) => ({
    id: order.legacyResourceId,
    name: order.name,
    created_at: order.createdAt,
    updated_at: at,
    cancelled_at: order.cancelledAt,
    cancel_reason: lower(order.cancelReason),
    total_price: amount(order.totalPriceSet),
    subtotal_price: amount(order.subtotalPriceSet),
    total_discounts: amount(order.totalDiscountsSet),
    currency: order.currencyCode,
    financial_status: lower(order.displayFinancialStatus),
    fulfillment_status: FULFILLMENT[order.displayFulfillmentStatus ?? ""] ?? null,
    source_name: order.sourceName,
    payment_gateway_names: order.paymentGatewayNames,
    discount_codes: order.discountCodes.map((code) => ({ code })),
    browser_ip: order.clientIp,
    customer: order.customer && {
      id: order.customer.legacyResourceId,
      created_at: order.customer.createdAt,
      verified_email: order.customer.verifiedEmail,
      state: lower(order.customer.state),
    },
    billing_address: address(order.billingAddress),
    shipping_address: address(order.shippingAddress),
    landing_site: path(visit?.landingPage),
    referring_site: visit?.referrerUrl ?? null,
    test: order.test,
  });

  const paid = order.transactions
    .filter((t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS")
    .map((t) => t.processedAt ?? t.createdAt)
    .sort()[0];
  const deliveries: PastDelivery[] = [{ topic: "orders/create", at: order.createdAt, body: body(order.createdAt) }];
  if (paid) deliveries.push({ topic: "orders/paid", at: paid, body: body(paid) });
  if (order.cancelledAt)
    deliveries.push({ topic: "orders/cancelled", at: order.cancelledAt, body: body(order.cancelledAt) });
  for (const refund of order.refunds) {
    const at = refund.createdAt ?? order.createdAt;
    const sent = refund.transactions.nodes[0];
    deliveries.push({
      topic: "refunds/create",
      at,
      body: {
        id: refund.legacyResourceId,
        order_id: order.legacyResourceId,
        created_at: at,
        note: refund.note,
        transactions: sent
          ? [{ amount: amount(sent.amountSet), gateway: sent.gateway, status: lower(sent.status) }]
          : [],
      },
    });
  }
  return deliveries;
}

/** The dispute's webhooks: opened, and closed when it has a final status. */
export function disputeDeliveries(dispute: ShopifyDispute): PastDelivery[] {
  const status = lower(dispute.status)!;
  const body = {
    id: dispute.legacyResourceId,
    order_id: dispute.order?.legacyResourceId ?? null,
    type: lower(dispute.type),
    amount: dispute.amount.amount,
    currency: dispute.amount.currencyCode,
    reason: lower(dispute.reasonDetails.reason),
    network_reason_code: dispute.reasonDetails.networkReasonCode,
    status,
    evidence_due_by: dispute.evidenceDueBy,
    initiated_at: dispute.initiatedAt,
    finalized_on: dispute.finalizedOn,
  };
  const deliveries: PastDelivery[] = [{ topic: "disputes/create", at: dispute.initiatedAt, body }];
  if (dispute.finalizedOn && FINAL_DISPUTE.has(status))
    deliveries.push({ topic: "disputes/update", at: dispute.finalizedOn, body });
  return deliveries;
}
