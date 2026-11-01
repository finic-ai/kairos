import type { ClientSettings } from "@finic-ai/kairos";
import { edge, handle, scriptTag, type Routing } from "./edge.js";

export interface FastlyOptions {
  /** The backend of your app. Default `origin`. */
  backend?: string;
  /** The backend for the Kairos API. Default `kairos`. */
  kairosBackend?: string;
  /** The Secret Store that holds `KAIROS_API_KEY`, and the other `KAIROS_*` values you use. Default `kairos`. */
  store?: string;
  /** Takes the requests that go on, in place of `backend`. */
  handler?: (request: Request, event: FastlyFetchEvent) => Response | Promise<Response>;
}

export interface FastlyFetchEvent {
  request: Request;
  client: { address: string; geo: { country_code?: string; as_number?: number } | null };
  respondWith(response: Promise<Response>): void;
  waitUntil(work: Promise<unknown>): void;
}

export interface FastlyRuntime {
  secret(store: string, name: string): Promise<string | undefined>;
  cached(key: string, load: () => Promise<{ value: string; ttl: number }>): Promise<string>;
  appendToHead(response: Response, html: string): Response;
  fetch(request: Request | string, init: RequestInit & { backend: string }): Promise<Response>;
}

const SETTINGS_TTL = 60;
const FAILED_TTL = 10;

interface Keys {
  apiKey?: string;
  hashKey?: string;
  publicKey?: string;
  url?: string;
}

let held: { key: string; routing: Routing } | undefined;

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fastlyWith(runtime: FastlyRuntime, options: FastlyOptions = {}): (event: FastlyFetchEvent) => void {
  const store = options.store ?? "kairos";
  const kairosBackend = options.kairosBackend ?? "kairos";

  const keys = async (): Promise<Keys> => {
    const read = (name: string) => runtime.secret(store, name).catch(() => undefined);
    const [apiKey, hashKey, publicKey, url] = await Promise.all(
      ["KAIROS_API_KEY", "KAIROS_HASH_KEY", "KAIROS_PUBLIC_KEY", "KAIROS_URL"].map(read),
    );
    return { apiKey, hashKey, publicKey, url };
  };

  const routingOf = (found: Keys & { apiKey: string }): Routing => {
    const key = [found.apiKey, found.hashKey, found.url].join("\n");
    if (held?.key !== key)
      held = {
        key,
        routing: edge({
          apiKey: found.apiKey,
          ...(found.hashKey ? { hashKey: found.hashKey } : {}),
          ...(found.url ? { baseUrl: found.url } : {}),
          fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
            runtime.fetch(input instanceof Request ? input : String(input), {
              ...init,
              backend: kairosBackend,
            })) as typeof fetch,
        }),
      };
    return held.routing;
  };

  // A new sandbox serves each request, so the settings are held in the POP's cache, not in memory.
  const settingsOf = async (on: Routing, apiKey: string): Promise<ClientSettings | undefined> => {
    const text = await runtime.cached(`kairos-settings-${await digest(apiKey)}`, async () => {
      try {
        return { value: JSON.stringify(await on.kairos.clientSettings()), ttl: SETTINGS_TTL };
      } catch (cause) {
        on.kairos.report(cause);
        return { value: "null", ttl: FAILED_TTL };
      }
    });
    return (JSON.parse(text) as ClientSettings | null) ?? undefined;
  };

  const withScript = (response: Response, found: Keys) => {
    const tag = scriptTag(response, found.publicKey, found.url);
    return tag && response.body ? runtime.appendToHead(response, tag) : response;
  };

  const respond = async (event: FastlyFetchEvent, waitUntil: (work: Promise<unknown>) => void) => {
    const origin = async (request: Request) =>
      options.handler
        ? options.handler(request, event)
        : runtime.fetch(request, { backend: options.backend ?? "origin" });
    const found = await keys();
    if (!found.apiKey) {
      console.warn(`Kairos: KAIROS_API_KEY is not in the Secret Store "${store}", so requests only go on.`);
      return withScript(await origin(event.request), found);
    }
    const on = routingOf({ ...found, apiKey: found.apiKey });
    const geo = event.client.geo;
    const response = await handle(on, event.request, {
      waitUntil,
      origin,
      ip: event.client.address,
      facts: {
        ...(geo?.country_code ? { country: geo.country_code } : {}),
        ...(geo?.as_number ? { asn: geo.as_number } : {}),
      },
      settings: () => settingsOf(on, found.apiKey!),
    });
    return withScript(response, found);
  };

  return (event) => {
    // Fastly takes `waitUntil` only during the event callback itself, so one promise holds all later work.
    const work: Promise<unknown>[] = [];
    let finished!: () => void;
    event.waitUntil(new Promise<void>((resolve) => (finished = resolve)).then(() => Promise.allSettled(work)));
    event.respondWith(respond(event, (promise) => void work.push(promise)).finally(() => finished()));
  };
}
