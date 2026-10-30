import { KairosError } from "./errors.js";

/**
 * Check a webhook from Kairos. Kairos signs as Standard Webhooks does
 * (https://www.standardwebhooks.com): the `webhook-signature` header holds one or more
 * "v1,<base64 HMAC-SHA256>" of "{webhook-id}.{webhook-timestamp}.{body}". It uses Web Crypto,
 * so it works in Node 18+, Deno, Bun and edge runtimes.
 */

/** What Kairos sends. `data` depends on `type`. */
export interface WebhookMessage<T = Record<string, unknown>> {
  /** The message id. The same on every retry: keep the ids you processed, and skip a repeat. */
  id: string;
  type:
    | "decision.created"
    | "decision.updated"
    | "label.created"
    | "case.created"
    | "case.assigned"
    | "case.resolved"
    | "case.reopened"
    | "webhook.test"
    | (string & {});
  version: number;
  workspace_id: string;
  /** Environment that produced the event. Absent on deliveries queued before environments. */
  environment_id?: string;
  created_at: string;
  data: T;
}

/** The delivery is not from Kairos, is too old, or is not what Kairos sends. Answer 400 or 401. */
export class KairosWebhookError extends KairosError {
  constructor(message: string) {
    super(message);
    this.name = "KairosWebhookError";
  }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function base64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Verify a delivery and return the message. Pass the body exactly as it arrived, before any
 * JSON parsing: a parsed and re-written body does not match its signature. `secret` is the
 * endpoint's `whsec_…` secret; during a rotation, pass the old and the new one.
 *
 *   const message = await verifyWebhook(await request.text(), request.headers, process.env.KAIROS_WEBHOOK_SECRET!);
 */
export async function verifyWebhook<T = Record<string, unknown>>(
  body: string | Uint8Array,
  headers: HeaderSource,
  secret: string | string[],
  options: { toleranceSeconds?: number; now?: Date } = {},
): Promise<WebhookMessage<T>> {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatures)
    throw new KairosWebhookError("Missing webhook-id, webhook-timestamp or webhook-signature header");

  const seconds = Number(timestamp);
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isInteger(seconds) || Math.abs(now - seconds) > tolerance)
    throw new KairosWebhookError("The webhook timestamp is too old or too far in the future");

  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${text}`);
  const candidates = signatures
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));
  for (const value of Array.isArray(secret) ? secret : [secret]) {
    const key = await crypto.subtle.importKey(
      "raw",
      base64(value.replace(/^whsec_/, "")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    for (const candidate of candidates) {
      let given: Uint8Array<ArrayBuffer>;
      try {
        given = base64(candidate);
      } catch {
        continue;
      }
      // `verify` compares in constant time.
      if (await crypto.subtle.verify("HMAC", key, given, signed)) {
        try {
          return JSON.parse(text) as WebhookMessage<T>;
        } catch {
          throw new KairosWebhookError("The webhook body is not JSON");
        }
      }
    }
  }
  throw new KairosWebhookError("No webhook signature matches the secret");
}
