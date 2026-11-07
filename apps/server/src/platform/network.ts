import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/** The address the request came from. Behind a proxy, the proxy's own address is of no use. */
export function clientIp(c: Context, trustProxy = false): string | undefined {
  if (trustProxy) return c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // not served over a socket, as in a test
  }
}

/** "::ffff:203.0.113.7" is the IPv4 address 203.0.113.7 seen through an IPv6 socket. */
export const normalizeIp = (ip: string) => ip.trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");

export function ipOf(c: Context, trustProxy = false): string | undefined {
  const address = clientIp(c, trustProxy);
  return address ? normalizeIp(address) : undefined;
}

const v4 = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

export function invalidIpRules(rules: string[]): string[] {
  return rules.filter((rule) => {
    const [address, bits, extra] = rule.trim().split("/");
    if (extra !== undefined || !address || !isIP(address)) return true;
    if (bits === undefined) return false;
    return isIP(address) !== 4 || !/^\d+$/.test(bits) || Number(bits) > 32;
  });
}

/** Whether an address is allowed. No rules means every address is. */
export function ipAllowed(ip: string | undefined, rules: string[]): boolean {
  if (rules.length === 0) return true;
  if (!ip) return false;
  const address = normalizeIp(ip);
  return rules.some((rule) => {
    const [range, bits] = rule.trim().split("/");
    if (bits === undefined) return normalizeIp(range!) === address;
    if (isIP(address) !== 4) return false;
    const size = 2 ** (32 - Number(bits));
    return Math.floor(v4(address) / size) === Math.floor(v4(range!) / size);
  });
}

/**
 * Websites a public key may be used on, as origins: "https://app.example.com". A name with
 * no scheme means https, and "https://*.example.com" covers every subdomain.
 */
export function normalizeOrigins(input: string[]): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const raw of input) {
    const text = raw.trim().toLowerCase();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
    const wildcard = /^https?:\/\/\*\./.test(withScheme);
    try {
      const url = new URL(wildcard ? withScheme.replace("*.", "") : withScheme);
      const plain = (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash && !url.username;
      if (!/^https?:$/.test(url.protocol) || !plain || url.host.includes("*") || !url.hostname)
        throw new Error("not an origin");
      const origin = `${url.protocol}//${wildcard ? "*." : ""}${url.host}`;
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      invalid.push(raw);
    }
  }
  return { origins, invalid };
}

/** Whether a request from this website is allowed. No rules means every website is. */
export function originAllowed(origin: string | undefined, rules: string[]): boolean {
  if (rules.length === 0) return true;
  if (!origin) return false;
  const from = origin.trim().toLowerCase();
  return rules.some((rule) => {
    const star = rule.indexOf("//*.");
    if (star < 0) return rule === from;
    // "https://*.example.com" matches "https://a.example.com", not "https://example.com".
    const scheme = rule.slice(0, star + 2);
    return from.startsWith(scheme) && from.endsWith(rule.slice(star + 3)) && from.length > rule.length - 1;
  });
}
