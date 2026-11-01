import { MAX_BODY_BYTES, readableBody } from "@finic-ai/kairos/routes";
import {
  EDGE_HEADER,
  Run,
  TRACKED_HEADER,
  edge,
  loadedSettings,
  verifyEdge,
  type Answer,
  type EdgeOptions,
  type Incoming,
  type Routing,
} from "./edge.js";

export type CloudFrontHeaders = Record<string, { key?: string; value: string }[]>;

export interface CloudFrontRequest {
  clientIp: string;
  method: string;
  uri: string;
  querystring: string;
  headers: CloudFrontHeaders;
  body?: { inputTruncated: boolean; action: string; encoding: "base64" | "text"; data: string };
}

export interface CloudFrontResponse {
  status: string;
  statusDescription?: string;
  headers: CloudFrontHeaders;
  body?: string;
}

export interface CloudFrontEvent {
  Records: { cf: { request: CloudFrontRequest; response?: CloudFrontResponse } }[];
}

// CloudFront caps the request headers; past this, the fields go without the request's body.
const MAX_HEADER = 4096;

const first = (headers: CloudFrontHeaders, name: string) => headers[name.toLowerCase()]?.[0]?.value;

function bodyOf(request: CloudFrontRequest): unknown {
  const { body } = request;
  if (!body?.data || body.inputTruncated) return undefined;
  if (!readableBody(first(request.headers, "content-type"), first(request.headers, "content-length"))) return undefined;
  const text =
    body.encoding === "base64"
      ? new TextDecoder().decode(Uint8Array.from(atob(body.data), (char) => char.charCodeAt(0)))
      : body.data;
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function incomingOf(request: CloudFrontRequest, withBody: boolean): Incoming {
  const host = first(request.headers, "host") ?? "localhost";
  const country = first(request.headers, "cloudfront-viewer-country");
  const asn = Number(first(request.headers, "cloudfront-viewer-asn"));
  return {
    method: request.method,
    url: new URL(`https://${host}${request.uri}${request.querystring ? `?${request.querystring}` : ""}`),
    header: (name) => first(request.headers, name),
    ip: request.clientIp,
    facts: { ...(country ? { country } : {}), ...(asn ? { asn } : {}) },
    ...(withBody ? { body: async () => bodyOf(request) } : {}),
  };
}

function generated(answer: Answer): CloudFrontResponse {
  // CloudFront caches what an origin request function answers, unless it is told not to.
  const headers: CloudFrontHeaders = { "cache-control": [{ key: "Cache-Control", value: "no-store" }] };
  if ("redirect" in answer)
    return { status: "302", headers: { ...headers, location: [{ key: "Location", value: answer.redirect }] } };
  return {
    status: String(answer.status),
    headers: { ...headers, "content-type": [{ key: "Content-Type", value: "application/json" }] },
    body: JSON.stringify(answer.body),
  };
}

/** `originRequest` goes on the origin request, with Include body; `originResponse` on the origin response. */
export function lambdaEdge(options: EdgeOptions | (() => Promise<EdgeOptions>)) {
  let routing: Promise<Routing> | undefined;
  const routingOf = () =>
    (routing ??= Promise.resolve(typeof options === "function" ? options() : options)
      .then(edge)
      .catch((cause) => {
        routing = undefined;
        throw cause;
      }));

  // Lambda@Edge has no `waitUntil`: a function waits for its sends before it returns.
  const running = async <T>(fn: (waitUntil: (work: Promise<unknown>) => void) => Promise<T>): Promise<T> => {
    const work: Promise<unknown>[] = [];
    try {
      return await fn((promise) => void work.push(promise));
    } finally {
      await Promise.allSettled(work);
    }
  };

  return {
    async originRequest(event: CloudFrontEvent): Promise<CloudFrontRequest | CloudFrontResponse> {
      const { request } = event.Records[0]!.cf;
      for (const name of Object.keys(request.headers)) if (name.startsWith("x-kairos-")) delete request.headers[name];
      let on: Routing | undefined;
      try {
        on = await routingOf();
        const routed = on;
        return await running(async (waitUntil) => {
          const run = await Run.start(
            routed,
            await loadedSettings(routed.kairos),
            incomingOf(request, true),
            waitUntil,
          );
          if (!run) return request;
          const { decision, answer } = await run.before();
          if (answer) return generated(answer);
          let signed = await run.header(decision, true);
          if (signed && signed.length > MAX_HEADER) {
            routed.report(`${run.live.route.route}: its fields are too large to pass to the origin response function.`);
            signed = await run.header(decision);
          }
          if (signed) request.headers[EDGE_HEADER] = [{ key: "X-Kairos-Edge", value: signed }];
          return request;
        });
      } catch (cause) {
        if (on) on.kairos.report(cause);
        else console.error("Kairos:", cause);
        return request;
      }
    },

    async originResponse(event: CloudFrontEvent): Promise<CloudFrontResponse> {
      const { request, response } = event.Records[0]!.cf;
      if (!response) throw new TypeError("originResponse is for the origin response event of CloudFront.");
      let on: Routing | undefined;
      try {
        on = await routingOf();
        const routed = on;
        return await running(async (waitUntil) => {
          const incoming = incomingOf(request, false);
          // The request's body reaches only the origin request function, which passed its fields here.
          const sent =
            routed.hash &&
            (await verifyEdge(routed.hash, first(request.headers, EDGE_HEADER), {
              method: request.method,
              path: incoming.url.pathname,
            }));
          if (sent && sent.fields) incoming.facts = { ...incoming.facts, ...sent.fields };
          const run = await Run.start(routed, await loadedSettings(routed.kairos), incoming, waitUntil);
          if (!run) return response;
          const after = await run.after({
            status: Number(response.status),
            header: (name) => first(response.headers, name),
          });
          if (after.answer) return generated(after.answer);
          delete response.headers[TRACKED_HEADER];
          return response;
        });
      } catch (cause) {
        if (on) on.kairos.report(cause);
        else console.error("Kairos:", cause);
        return response;
      }
    },
  };
}
