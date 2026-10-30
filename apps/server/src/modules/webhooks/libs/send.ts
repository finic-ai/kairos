import { lookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Sending to a URL that a customer chose. The server calls it from inside its own network, so
 * an address in a private, local or reserved range is refused: otherwise a webhook could reach
 * a database, a metadata service or an admin page that is not on the internet.
 */

const blocked = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, bits, "ipv4");
for (const [network, bits] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, bits, "ipv6");
}

/** The IPv4 address inside an IPv6 one that carries it: "::ffff:10.0.0.1" and the NAT64 "64:ff9b::10.0.0.1". */
function embeddedIpv4(address: string): string | undefined {
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return undefined;
  const high = parseInt(hex[1]!, 16),
    low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isPrivateAddress(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, "");
  const family = isIP(plain);
  if (family === 4) return blocked.check(plain, "ipv4");
  if (family === 6) {
    const inner = embeddedIpv4(plain);
    return inner ? blocked.check(inner, "ipv4") : blocked.check(plain, "ipv6");
  }
  return true;
}

/** What is wrong with a URL as a webhook endpoint, or undefined. Checked when it is saved; the address is checked again at each send. */
export function urlProblem(text: string, allowPrivate: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return "must start with https://";
  if (url.username || url.password) return "must not contain a user name or a password";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !allowPrivate &&
    (isIP(host) ? isPrivateAddress(host) : host === "localhost" || host.endsWith(".localhost") || !host.includes("."))
  ) {
    return "must be an address on the internet, not a private or local one";
  }
  return undefined;
}

export interface SendResult {
  status?: number;
  body: string;
  ms: number;
  problem?: string;
}

const MAX_BODY = 4096;

class AddressRefused extends Error {}

/** A DNS lookup that refuses private addresses. The connection is made to the address it checked, so a second answer cannot change it. */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: (...args: any[]) => void) => {
    lookup(hostname, { family: options.family ?? 0, all: true }, (cause, addresses: LookupAddress[]) => {
      if (cause) return callback(cause);
      const refused = addresses.find((a) => isPrivateAddress(a.address));
      if (refused && !allowPrivate)
        return callback(new AddressRefused(`${hostname} resolves to ${refused.address}, a private or local address`));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

function describe(cause: unknown): string {
  if (cause instanceof AddressRefused) return cause.message;
  const code = (cause as NodeJS.ErrnoException)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the host name was not found";
  if (code === "ECONNREFUSED") return "the connection was refused";
  if (code === "ECONNRESET") return "the connection was closed";
  if (
    (code && code.startsWith("ERR_TLS")) ||
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  )
    return `the TLS certificate was refused (${code})`;
  return (cause as Error)?.message || "the request failed";
}

/** POST a body. No redirect is followed, and the answer is read up to 4 KB. Never throws. */
export function send(
  target: string,
  headers: Record<string, string>,
  body: string,
  options: { allowPrivate: boolean; timeoutMs?: number },
): Promise<SendResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<SendResult, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, ms: Date.now() - started });
    };
    const problem = urlProblem(target, options.allowPrivate);
    if (problem) return finish({ body: "", problem: `the URL ${problem}` });
    const url = new URL(target);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: guardedLookup(options.allowPrivate) as any,
      agent: false,
    });
    timer = setTimeout(() => {
      request.destroy();
      finish({ body: "", problem: `no answer within ${timeoutMs / 1000} s` });
    }, timeoutMs);
    request.on("error", (cause) => finish({ body: "", problem: describe(cause) }));
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () => {
        const status = response.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY);
        if (status >= 200 && status < 300) return finish({ status, body: text });
        const location = response.headers.location;
        finish({
          status,
          body: text,
          problem:
            status >= 300 && status < 400
              ? `redirects are not followed (${status}${location ? ` to ${location}` : ""})`
              : `answered ${status}`,
        });
      };
      response.on("data", (chunk: Buffer) => {
        if (size < MAX_BODY) chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_BODY) {
          response.destroy();
          done();
        }
      });
      response.on("end", done);
      response.on("error", done);
    });
    request.end(body);
  });
}
