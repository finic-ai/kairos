import { createHmac, randomBytes } from "node:crypto";

/**
 * Signatures as in Standard Webhooks (https://www.standardwebhooks.com), so that a receiver can
 * check them with an existing library. A secret is "whsec_" and 32 random bytes in base64; the
 * bytes are the HMAC key. The signature covers "{id}.{timestamp}.{body}".
 */

export const newSigningSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

export const secretHint = (secret: string) => `${secret.slice(0, 10)}…${secret.slice(-4)}`;

export function signature(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** The headers of one attempt. With two secrets, during a rotation, two signatures separated by a space. */
export function signedHeaders(secrets: string[], id: string, timestamp: number, body: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "Kairos-Webhooks/1",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": secrets.map((secret) => signature(secret, id, timestamp, body)).join(" "),
  };
}
