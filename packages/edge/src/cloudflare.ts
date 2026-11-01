import type { Routing } from "@finic-ai/kairos/routes";
import { edge, handle } from "./edge.js";

export interface KairosEnv {
  /** A secret key (`ksk_`). */
  KAIROS_API_KEY?: string;
  KAIROS_HASH_KEY?: string;
  /** A public key (`kpk_`). With it, the Worker adds the website script to each HTML page. */
  KAIROS_PUBLIC_KEY?: string;
  KAIROS_URL?: string;
}

interface ExecutionContext {
  waitUntil(work: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface FetchHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

interface Element {
  append(content: string, options: { html: boolean }): void;
}
declare const HTMLRewriter: new () => {
  on(selector: string, handlers: { element(element: Element): void }): { transform(response: Response): Response };
};

const DEFAULT_URL = "https://kairos.finic.ai";

let held: { key: string; routing: Routing } | undefined;

function routingOf(env: KairosEnv & { KAIROS_API_KEY: string }): Routing {
  const key = [env.KAIROS_API_KEY, env.KAIROS_HASH_KEY, env.KAIROS_URL].join("\n");
  if (held?.key !== key)
    held = {
      key,
      routing: edge({
        apiKey: env.KAIROS_API_KEY,
        ...(env.KAIROS_HASH_KEY ? { hashKey: env.KAIROS_HASH_KEY } : {}),
        ...(env.KAIROS_URL ? { baseUrl: env.KAIROS_URL } : {}),
      }),
    };
  return held.routing;
}

const attribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function withScript(response: Response, env: KairosEnv): Response {
  const key = env.KAIROS_PUBLIC_KEY;
  if (!key || !/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return response;
  const src = `${(env.KAIROS_URL ?? DEFAULT_URL).replace(/\/+$/, "")}/kairos.js`;
  const tag = `<script async src="${attribute(src)}" data-api-key="${attribute(key)}"></script>`;
  return new HTMLRewriter().on("head", { element: (head) => head.append(tag, { html: true }) }).transform(response);
}

let warned = false;

/** `export default cloudflare()`. With `handler`, its `fetch` takes the requests that go on, not the origin. */
export function cloudflare<Env extends KairosEnv, Handler extends Partial<FetchHandler<Env>> = object>(
  handler?: Handler,
): Omit<Handler, "fetch"> & FetchHandler<Env> {
  return {
    ...(handler as Handler),
    async fetch(request, env, ctx) {
      ctx.passThroughOnException();
      const origin = async (forwarded: Request) =>
        handler?.fetch ? handler.fetch(forwarded, env, ctx) : fetch(forwarded);
      if (!env.KAIROS_API_KEY) {
        if (!warned) console.warn("Kairos: KAIROS_API_KEY is not set, so the Worker only sends requests on.");
        warned = true;
        return withScript(await origin(request), env);
      }
      const cf = (request as { cf?: { country?: string; asn?: number } }).cf;
      const response = await handle(routingOf({ ...env, KAIROS_API_KEY: env.KAIROS_API_KEY }), request, {
        waitUntil: (work) => ctx.waitUntil(work),
        origin,
        ip: request.headers.get("cf-connecting-ip") ?? undefined,
        facts: { ...(cf?.country ? { country: cf.country } : {}), ...(cf?.asn ? { asn: cf.asn } : {}) },
      });
      return withScript(response, env);
    },
  };
}
