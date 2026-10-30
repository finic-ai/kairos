import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostApproved } from "@kairos/core";
import { guardedLookup, urlProblem } from "../../webhooks/libs";

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
/** Not SVG, which can hold script. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"];

export const INLINE_TYPES = [...IMAGE_TYPES, "application/pdf", "text/plain"];
const DATA_ADDRESS = /^data:([a-z]+\/[a-z0-9.+-]+)?((?:;[a-z-]+=[^;,]*)*);base64,/i;

export type MediaRead =
  MediaResult | { ok: false; reason: "missing" | "not_a_link" | "host_not_approved"; problem: string };

export const MEDIA_ERROR = {
  missing: [404, "not_found"],
  not_a_link: [404, "not_found"],
  host_not_approved: [403, "host_not_approved"],
  expired: [410, "link_expired"],
  too_large: [413, "too_large"],
  not_an_image: [415, "not_an_image"],
  failed: [502, "unreachable"],
} as const;

export const mediaHeaders = (type: string) => ({
  "Content-Type": type,
  "Cache-Control": "private, max-age=300",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox",
  "Content-Disposition": INLINE_TYPES.includes(type) ? "inline" : "attachment",
});

export async function readMedia(
  value: unknown,
  hosts: string[],
  options: { image: boolean; allowPrivate: boolean },
): Promise<MediaRead> {
  if (value === null || value === undefined || value === "")
    return { ok: false, reason: "missing", problem: "It has no value" };
  const text = String(value);
  if (isDataAddress(text)) return readDataAddress(text, options);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "not_a_link", problem: "It does not hold an address" };
  }
  if (!hostApproved(url.hostname, hosts))
    return {
      ok: false,
      reason: "host_not_approved",
      problem: `The host ${url.hostname} is not approved for this workspace`,
    };
  return fetchMedia(url, options);
}

export const isDataAddress = (text: string) => DATA_ADDRESS.test(text);

export function readDataAddress(text: string, options: { image: boolean }): MediaResult {
  const match = DATA_ADDRESS.exec(text);
  if (!match) return { ok: false, reason: "failed", problem: "It is not a base64 data address" };
  const type = (match[1] ?? "application/octet-stream").toLowerCase();
  if (options.image && !IMAGE_TYPES.includes(type))
    return { ok: false, reason: "not_an_image", problem: `It is ${type}, not an image` };
  const content = text.slice(match[0].length);
  if ((content.length * 3) / 4 > MAX_MEDIA_BYTES)
    return { ok: false, reason: "too_large", problem: "It is larger than 15 MB" };
  return { ok: true, type, body: Buffer.from(content, "base64") };
}
const TIMEOUT_MS = 10_000;

export type MediaResult =
  | { ok: true; type: string; body: Buffer }
  /** `expired`: the address answered 401, 403 or 410, as a signed link does after it expires. */
  | { ok: false; reason: "expired" | "failed" | "too_large" | "not_an_image"; problem: string };

/** A redirect is not followed: it could lead to a host that is not approved. */
export function fetchMedia(url: URL, options: { image: boolean; allowPrivate: boolean }): Promise<MediaResult> {
  const wrong = urlProblem(url.toString(), options.allowPrivate);
  if (wrong) return Promise.resolve({ ok: false, reason: "failed", problem: `The address ${wrong}` });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: MediaResult) => (settled ? undefined : ((settled = true), resolve(r)));
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = client(
      url,
      { method: "GET", lookup: guardedLookup(options.allowPrivate) as never, agent: false, timeout: TIMEOUT_MS },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "application/octet-stream")
          .split(";")[0]!
          .trim();
        const fail = (reason: Exclude<MediaResult, { ok: true }>["reason"], problem: string) => (
          res.destroy(),
          finish({ ok: false, reason, problem })
        );
        if (status === 401 || status === 403 || status === 410) return fail("expired", `The link answered ${status}`);
        if (status < 200 || status >= 300) return fail("failed", `The address answered ${status}`);
        if (options.image && !IMAGE_TYPES.includes(type)) return fail("not_an_image", `It is ${type}, not an image`);
        if (Number(res.headers["content-length"] ?? 0) > MAX_MEDIA_BYTES)
          return fail("too_large", "It is larger than 15 MB");
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_MEDIA_BYTES) return fail("too_large", "It is larger than 15 MB");
          chunks.push(chunk);
        });
        res.on("end", () => finish({ ok: true, type, body: Buffer.concat(chunks) }));
        res.on("error", (cause) => finish({ ok: false, reason: "failed", problem: cause.message }));
      },
    );
    req.on("timeout", () => (req.destroy(), finish({ ok: false, reason: "failed", problem: "No answer within 10 s" })));
    req.on("error", (cause) => finish({ ok: false, reason: "failed", problem: cause.message }));
    req.end();
  });
}
