import { Kairos, type Decision, type EventProperties, type Scope } from "@finic-ai/kairos";
import {
  EDGE_HEADER,
  MAX_BODY_BYTES,
  TRACKED_HEADER,
  answerResponse,
  currentSettings,
  decideRoute,
  liveRoute,
  readCookie,
  readableBody,
  requestCookies,
  routing,
  signEdge,
  trackAfter,
  type Hash,
  type Live,
  type RequestParts,
  type Routing,
} from "@finic-ai/kairos/routes";

export interface EdgeOptions {
  apiKey: string;
  /** Also signs the header that the middleware at the origin checks. */
  hashKey?: string;
  baseUrl?: string;
  onError?: (error: Error) => void;
}

export interface Platform {
  waitUntil(work: Promise<unknown>): void;
  origin(request: Request): Promise<Response>;
  ip?: string;
  facts?: EventProperties;
}

function hmac(key: string): Hash {
  const encoder = new TextEncoder();
  const imported = crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return async (value) => {
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await imported, encoder.encode(value)));
    return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
}

export function edge(options: EdgeOptions): Routing {
  const kairos = new Kairos({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    // A timer does not keep an isolate alive: each send is handed to `waitUntil`.
    flushIntervalMs: 0,
  });
  return routing(kairos, options.hashKey ? hmac(options.hashKey) : undefined);
}

// A clone's cancel settles only once the other branch is done too, so nothing waits for it.
const drop = (body: ReadableStream | ReadableStreamDefaultReader | null | undefined) =>
  void body?.cancel().catch(() => {});

async function readJson(message: Request | Response): Promise<unknown> {
  const type = message.headers.get("content-type") ?? undefined;
  if (!message.body || !readableBody(type, message.headers.get("content-length") ?? undefined)) {
    drop(message.body);
    return undefined;
  }
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      drop(reader);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

const reads = (live: Live, from: "request.body" | "response.body") =>
  Object.values(live.route.fields).some((field) => field.from === from);

function withoutTracked(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.delete(TRACKED_HEADER);
  return out;
}

export async function handle(on: Routing, request: Request, platform: Platform): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-kairos-")) headers.delete(name);
  const forward = () => new Request(request, { headers });

  const url = new URL(request.url);
  const settings = currentSettings(on.kairos, platform.waitUntil);
  const live = liveRoute(on, settings, request.method, url.pathname);
  if (!live) return platform.origin(forward());

  let sent = false;
  let response: Response | undefined;
  try {
    const cookie = request.headers.get("cookie") ?? undefined;
    const known = requestCookies(live.settings, cookie, live.hash);
    const session = await known.session;
    const scope: Scope = {
      subject: "user",
      tracked: new Set(),
      resolve: () => ({ entities: { device: known.device, ip: platform.ip }, session: session ?? known.visit }),
    };
    const { auto, autoDecide } = on.kairos.bind(scope);
    const body = reads(live, "request.body") ? await readJson(request.clone()) : undefined;
    const parts = (responseBody?: unknown): RequestParts => ({
      body,
      query: (name) => url.searchParams.get(name) ?? undefined,
      header: (name) => request.headers.get(name) ?? undefined,
      cookie: (name) => readCookie(cookie, name),
      params: live.params,
      responseHeader: (name) => response?.headers.get(name) ?? undefined,
      responseBody,
    });

    let decision: Decision | undefined;
    if (live.route.mode === "decide_request") {
      const decided = await decideRoute(live, parts(), autoDecide, platform.facts);
      platform.waitUntil(on.kairos.flush());
      if (decided.answer) return answerResponse(decided.answer);
      decision = decided.decision;
    }
    if (live.hash)
      headers.set(EDGE_HEADER, await signEdge(live.hash, { method: request.method, path: url.pathname, decision }));

    sent = true;
    response = await platform.origin(forward());
    const copy = reads(live, "response.body") ? response.clone() : undefined;
    if (live.route.mode === "decide_response" && response.status < 400) {
      const decided = await decideRoute(live, parts(copy && (await readJson(copy))), autoDecide, platform.facts);
      platform.waitUntil(on.kairos.flush());
      if (!decided.answer) return response;
      drop(response.body);
      return answerResponse(decided.answer);
    }
    if (response.headers.has(TRACKED_HEADER)) {
      drop(copy?.body);
      return withoutTracked(response);
    }
    const status = response.status;
    platform.waitUntil(
      (async () => trackAfter(live, parts(copy && (await readJson(copy))), auto, status, platform.facts))().catch(
        (cause) => on.kairos.report(cause),
      ),
    );
    return response;
  } catch (cause) {
    if (response) return response;
    if (sent) throw cause;
    on.kairos.report(cause);
    return platform.origin(forward());
  }
}
