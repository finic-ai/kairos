import { createHmac, timingSafeEqual } from "node:crypto";
import type { Verification } from "../types";

export type { Verification };

export const SCHEMES = ["hmac", "timestamped", "stripe", "standard", "header", "none"] as const;

/** Whether a scheme needs a secret to check, which must be stored encrypted. */
export const needsSecret = (v: Verification) => v.scheme !== "none";
/** Whether the sender is proven by a signature over the body, which lets a mapping set entity properties. */
export const signs = (v: Verification) =>
  v.scheme === "hmac" || v.scheme === "timestamped" || v.scheme === "stripe" || v.scheme === "standard";

const STRIPE = {
  header: "Stripe-Signature",
  timestampKey: "t",
  signatureKey: "v1",
  join: ".",
  algorithm: "sha256",
  encoding: "hex",
} as const;

/** The headers that carry a secret or a signature: they are not kept in the delivery log. */
export function secretHeaders(v: Verification): string[] {
  const own =
    v.scheme === "hmac" || v.scheme === "header"
      ? [v.header]
      : v.scheme === "timestamped"
        ? [v.header]
        : v.scheme === "stripe"
          ? [STRIPE.header]
          : v.scheme === "standard"
            ? ["webhook-signature", "svix-signature"]
            : [];
  return [...own.map((h) => h.toLowerCase()), "authorization", "cookie", "proxy-authorization"];
}

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A signed time, in seconds: Unix seconds, or an ISO 8601 time (Zendesk). */
function seconds(time: string): number | null {
  if (/^\d+$/.test(time)) return Number(time);
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** "t=1,v1=a,v1=b" (and "t=1,v1=a t=2,v1=b" during a rotation) → the time and the signatures. */
function pairs(header: string, timeKey: string, signatureKey: string): { time?: string; signatures: string[] } {
  const parts = header.split(/[,\s]+/).map((p) => {
    const at = p.indexOf("=");
    return at < 0 ? [p, ""] : [p.slice(0, at), p.slice(at + 1)];
  });
  return {
    time: parts.find(([k]) => k === timeKey)?.[1],
    signatures: parts
      .filter(([k]) => k === signatureKey)
      .map(([, v]) => v!)
      .filter(Boolean),
  };
}

/** null when the delivery is proven, or why not. `secrets`: any of them may match, for a rotation. */
export function verify(
  v: Verification,
  raw: Buffer,
  headers: Record<string, string>,
  secrets: string[],
  now: Date,
): string | null {
  if (v.scheme === "none") return null;
  if (secrets.length === 0) return "the source has no secret";

  if (v.scheme === "header") {
    const given = headers[v.header.toLowerCase()];
    if (!given) return `no ${v.header} header`;
    return secrets.some((s) => equal(given, s)) ? null : `${v.header} does not match`;
  }

  if (v.scheme === "hmac") {
    const given = headers[v.header.toLowerCase()]?.trim();
    if (!given) return `no ${v.header} header`;
    // Some providers send a list during a rotation: "v1=a,v1=b" (Fingerprint).
    const candidates = [given, ...given.split(",").map((s) => s.trim())];
    const ok = secrets.some((secret) => {
      const digest = createHmac(v.algorithm ?? "sha256", secret)
        .update(raw)
        .digest(v.encoding ?? "hex");
      return candidates.some((c) => equal(c, `${v.prefix ?? ""}${digest}`));
    });
    return ok ? null : "the signature does not match";
  }

  if (v.scheme === "standard") {
    // Svix sends the same headers with an "svix-" prefix.
    const id = headers["webhook-id"] ?? headers["svix-id"];
    const time = headers["webhook-timestamp"] ?? headers["svix-timestamp"];
    const given = headers["webhook-signature"] ?? headers["svix-signature"];
    if (!id || !time || !given) return "no webhook-id, webhook-timestamp or webhook-signature header";
    if (!/^\d+$/.test(time) || Math.abs(now.getTime() / 1000 - Number(time)) > (v.tolerance ?? 300))
      return "the signed time is more than 5 minutes away";
    const candidates = given
      .split(" ")
      .filter((s) => s.startsWith("v1,"))
      .map((s) => s.slice(3));
    const signed = Buffer.concat([Buffer.from(`${id}.${time}.`), raw]);
    const ok = secrets.some((secret) => {
      // The secret is "whsec_" and base64; the key is its bytes.
      const expected = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
        .update(signed)
        .digest("base64");
      return candidates.some((c) => equal(c, expected));
    });
    return ok ? null : "the signature does not match";
  }

  const t: Extract<Verification, { scheme: "timestamped" }> =
    v.scheme === "stripe" ? { scheme: "timestamped", ...STRIPE, tolerance: v.tolerance } : v;
  const header = headers[t.header.toLowerCase()];
  if (!header) return `no ${t.header} header`;
  let time: string | undefined;
  let signatures: string[];
  if (t.timestampHeader) {
    time = headers[t.timestampHeader.toLowerCase()];
    signatures = [header.trim()];
  } else {
    ({ time, signatures } = pairs(header, t.timestampKey ?? "t", t.signatureKey ?? "v1"));
  }
  if (!time || signatures.length === 0)
    return t.timestampHeader
      ? `no ${t.timestampHeader} header`
      : `${t.header} has no ${t.timestampKey ?? "t"}= or ${t.signatureKey ?? "v1"}=`;
  const at = seconds(time);
  if (at === null || Math.abs(now.getTime() / 1000 - at) > (t.tolerance ?? 300))
    return "the signed time is more than 5 minutes away";
  const signed = Buffer.concat([Buffer.from(`${time}${t.join ?? "."}`), raw]);
  const ok = secrets.some((secret) => {
    const expected = createHmac(t.algorithm ?? "sha256", secret)
      .update(signed)
      .digest(t.encoding ?? "hex");
    return signatures.some((given) => equal(given, expected));
  });
  return ok ? null : "the signature does not match";
}

const HEADER = /^[A-Za-z0-9-]{1,64}$/;

export function verificationProblem(v: unknown): string | null {
  if (!v || typeof v !== "object") return "verification: must be an object with a scheme";
  const x = v as Record<string, unknown>;
  if (!SCHEMES.includes(x.scheme as (typeof SCHEMES)[number]))
    return `verification.scheme: must be one of ${SCHEMES.join(", ")}`;
  if (
    (x.scheme === "hmac" || x.scheme === "header" || x.scheme === "timestamped") &&
    (typeof x.header !== "string" || !HEADER.test(x.header))
  )
    return "verification.header: the name of the header, such as X-Signature";
  if (x.scheme === "hmac" || x.scheme === "timestamped") {
    if (x.algorithm !== undefined && !["sha256", "sha1", "sha512"].includes(x.algorithm as string))
      return "verification.algorithm: sha256, sha1 or sha512";
    if (x.encoding !== undefined && !["hex", "base64"].includes(x.encoding as string))
      return "verification.encoding: hex or base64";
  }
  if (x.scheme === "hmac" && x.prefix !== undefined && (typeof x.prefix !== "string" || x.prefix.length > 32))
    return "verification.prefix: text such as sha256=";
  if (x.scheme === "timestamped") {
    if (x.timestampHeader !== undefined && (typeof x.timestampHeader !== "string" || !HEADER.test(x.timestampHeader)))
      return "verification.timestampHeader: the name of the header with the time";
    for (const key of ["timestampKey", "signatureKey"] as const) {
      if (x[key] !== undefined && (typeof x[key] !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(x[key] as string)))
        return `verification.${key}: a short key, such as t or v1`;
    }
    if (x.join !== undefined && (typeof x.join !== "string" || x.join.length > 4))
      return "verification.join: the text between the time and the body, such as .";
  }
  if (
    (x.scheme === "stripe" || x.scheme === "timestamped" || x.scheme === "standard") &&
    x.tolerance !== undefined &&
    (typeof x.tolerance !== "number" || x.tolerance < 1 || x.tolerance > 3600)
  )
    return "verification.tolerance: seconds, 1 to 3600";
  return null;
}
