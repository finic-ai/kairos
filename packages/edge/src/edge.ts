import { Kairos, type ClientSettings, type Decision, type EventProperties, type Scope } from "@finic-ai/kairos";
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
  routeFields,
  routing,
  signEdge,
  trackAfter,
  type Answer,
  type Hash,
  type Live,
  type RequestParts,
  type Routing,
} from "@finic-ai/kairos/routes";

export {
  EDGE_HEADER,
  TRACKED_HEADER,
  loadedSettings,
  verifyEdge,
  type Answer,
  type Routing,
} from "@finic-ai/kairos/routes";

export interface EdgeOptions {
  apiKey: string;
  /** Also signs the header that the middleware at the origin checks. */
  hashKey?: string;
  baseUrl?: string;
  onError?: (error: Error) => void;
  fetch?: typeof fetch;
}

export const DEFAULT_URL = "https://kairos.finic.ai";

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
    onError: options.onError ?? ((error) => console.error("Kairos:", error)),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    // A timer does not keep an isolate alive: each send is handed to `waitUntil`.
    flushIntervalMs: 0,
  });
  return routing(kairos, options.hashKey ? hmac(options.hashKey) : undefined);
}

export interface Incoming {
  method: string;
  url: URL;
  header(name: string): string | undefined;
  ip?: string;
  /** Properties of each event of the route, such as the country. The route's fields win. */
  facts?: EventProperties;
  body?(): Promise<unknown>;
}

export interface Outgoing {
  status: number;
  header(name: string): string | undefined;
  body?(): Promise<unknown>;
}

const reads = (live: Live, from: "request.body" | "response.body") =>
  Object.values(live.route.fields).some((field) => field.from === from);

export class Run {
  private constructor(
    readonly live: Live,
    private readonly incoming: Incoming,
    private readonly waitUntil: (work: Promise<unknown>) => void,
    private readonly client: ReturnType<Kairos["bind"]>,
    private readonly body: unknown,
  ) {}

  static async start(
    on: Routing,
    settings: ClientSettings | undefined,
    incoming: Incoming,
    waitUntil: (work: Promise<unknown>) => void,
  ): Promise<Run | undefined> {
    const live = liveRoute(on, settings, incoming.method, incoming.url.pathname);
    if (!live) return undefined;
    const known = requestCookies(live.settings, incoming.header("cookie"), live.hash);
    const session = await known.session;
    const scope: Scope = {
      subject: "user",
      tracked: new Set(),
      resolve: () => ({ entities: { device: known.device, ip: incoming.ip }, session: session ?? known.visit }),
    };
    const body = reads(live, "request.body") ? await incoming.body?.() : undefined;
    return new Run(live, incoming, waitUntil, on.kairos.bind(scope), body);
  }

  get readsResponseBody(): boolean {
    return reads(this.live, "response.body");
  }

  private parts(out?: Outgoing, responseBody?: unknown): RequestParts {
    const { incoming } = this;
    return {
      body: this.body,
      query: (name) => incoming.url.searchParams.get(name) ?? undefined,
      header: (name) => incoming.header(name),
      cookie: (name) => readCookie(incoming.header("cookie"), name),
      params: this.live.params,
      responseHeader: (name) => out?.header(name),
      responseBody,
    };
  }

  private async decide(parts: RequestParts): Promise<{ decision?: Decision; answer?: Answer }> {
    const decided = await decideRoute(this.live, parts, this.client.autoDecide, this.incoming.facts);
    this.waitUntil(this.live.kairos.flush());
    return decided;
  }

  before(): Promise<{ decision?: Decision; answer?: Answer }> {
    return this.live.route.mode === "decide_request" ? this.decide(this.parts()) : Promise.resolve({});
  }

  async header(decision: Decision | undefined, withFields = false): Promise<string | undefined> {
    const { hash } = this.live;
    if (!hash) return undefined;
    const fields = withFields ? await routeFields(this.live, this.parts()) : undefined;
    return signEdge(hash, { method: this.incoming.method, path: this.incoming.url.pathname, decision, fields });
  }

  async after(out: Outgoing): Promise<{ answer?: Answer; tracked: boolean }> {
    if (out.header(TRACKED_HEADER)) return { tracked: true };
    const responseBody = this.readsResponseBody ? await out.body?.() : undefined;
    const parts = this.parts(out, responseBody);
    if (this.live.route.mode === "decide_response" && out.status < 400) {
      const { answer } = await this.decide(parts);
      return { answer, tracked: false };
    }
    const work = trackAfter(this.live, parts, this.client.auto, out.status, this.incoming.facts);
    if (work) this.waitUntil(work);
    return { tracked: false };
  }
}

// A clone's cancel settles only once the other branch is done too, so nothing waits for it.
const drop = (body: ReadableStream | ReadableStreamDefaultReader | null | undefined) =>
  void body?.cancel().catch(() => {});

async function readUpTo(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) return { chunks, size, done: true };
    chunks.push(value);
    size += value.byteLength;
  }
  return { chunks, size, done: false };
}

function parse(chunks: Uint8Array[], size: number): unknown {
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

const readable = (message: Request | Response) =>
  !!message.body &&
  readableBody(message.headers.get("content-type") ?? undefined, message.headers.get("content-length") ?? undefined);

/** Reads the body to its end: give it a clone. */
export async function readJson(message: Request): Promise<unknown> {
  if (!readable(message)) {
    drop(message.body);
    return undefined;
  }
  const reader = message.body!.getReader();
  const read = await readUpTo(reader);
  if (!read.done) drop(reader);
  return read.done ? parse(read.chunks, read.size) : undefined;
}

// Not with a clone: on Fastly, a backend's response has none.
async function peekJson(response: Response): Promise<{ json: unknown; response: Response }> {
  if (!readable(response)) return { json: undefined, response };
  const reader = response.body!.getReader();
  const { chunks, size, done } = await readUpTo(reader);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { json: done ? parse(chunks, size) : undefined, response: new Response(body, response) };
}

export const withoutKairosHeaders = (headers: Headers): Headers => {
  const out = new Headers(headers);
  for (const name of [...out.keys()]) if (name.startsWith("x-kairos-")) out.delete(name);
  return out;
};

const attribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function scriptTag(response: Response, publicKey: string | undefined, baseUrl: string | undefined) {
  if (!publicKey || !/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return undefined;
  const src = `${(baseUrl ?? DEFAULT_URL).replace(/\/+$/, "")}/kairos.js`;
  return `<script async src="${attribute(src)}" data-api-key="${attribute(publicKey)}"></script>`;
}

export interface Platform {
  waitUntil(work: Promise<unknown>): void;
  origin(request: Request): Promise<Response>;
  ip?: string;
  facts?: EventProperties;
  settings?(): Promise<ClientSettings | undefined>;
}

export async function handle(on: Routing, request: Request, platform: Platform): Promise<Response> {
  const headers = withoutKairosHeaders(request.headers);
  const forward = () => new Request(request, { headers });
  let sent = false;
  let response: Response | undefined;
  try {
    const settings = platform.settings ? await platform.settings() : currentSettings(on.kairos, platform.waitUntil);
    const run = await Run.start(
      on,
      settings,
      {
        method: request.method,
        url: new URL(request.url),
        header: (name) => request.headers.get(name) ?? undefined,
        ip: platform.ip,
        facts: platform.facts,
        body: () => readJson(request.clone()),
      },
      platform.waitUntil,
    );
    if (!run) return await platform.origin(forward());

    const { decision, answer } = await run.before();
    if (answer) return answerResponse(answer);
    const signed = await run.header(decision);
    if (signed) headers.set(EDGE_HEADER, signed);

    sent = true;
    response = await platform.origin(forward());
    let json: unknown;
    if (run.readsResponseBody) ({ json, response } = await peekJson(response));
    const { headers: returned, status } = response;
    const after = await run.after({
      status,
      header: (name) => returned.get(name) ?? undefined,
      body: async () => json,
    });
    if (after.answer) {
      drop(response.body);
      return answerResponse(after.answer);
    }
    if (!after.tracked) return response;
    const out = new Response(response.body, response);
    out.headers.delete(TRACKED_HEADER);
    return out;
  } catch (cause) {
    if (sent && !response) throw cause;
    on.kairos.report(cause);
    return response ?? platform.origin(forward());
  }
}
