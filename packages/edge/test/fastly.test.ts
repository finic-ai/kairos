import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClientSettings } from "@finic-ai/kairos";
import { verifyEdge } from "@finic-ai/kairos/routes";
import { fastlyWith, type FastlyFetchEvent } from "../src/fastly-handler.js";

const hash = (value: string) => createHmac("sha256", "hash-key").update(value).digest("hex");
let keys = 0;

function service(secrets: Record<string, string>, settings: ClientSettings) {
  const api: string[] = [];
  const events: any[] = [];
  const seen: Request[] = [];
  const cache = new Map<string, string>();
  let origin = (_request: Request) => new Response("ok");
  const handler = fastlyWith({
    secret: async (store, name) => (store === "kairos" ? secrets[name] : undefined),
    cached: async (key, load) => {
      if (!cache.has(key)) cache.set(key, (await load()).value);
      return cache.get(key)!;
    },
    appendToHead: (response, html) => new Response(`${html}|${response.headers.get("content-type")}`, response),
    fetch: async (request, init) => {
      if (init.backend === "origin") {
        const forwarded = request as Request;
        seen.push(forwarded);
        return origin(forwarded);
      }
      const path = new URL(String(request)).pathname;
      api.push(`${init.backend} ${path}`);
      if (path === "/v1/client-settings") return Response.json(settings);
      events.push(...JSON.parse(String(init.body)).batch);
      return Response.json({ accepted: 1 }, { status: 202 });
    },
  });
  const call = async (path: string, init: RequestInit = {}) => {
    let waited = 0;
    let respond!: Promise<Response>;
    const work: Promise<unknown>[] = [];
    const event: FastlyFetchEvent = {
      request: new Request(`https://shop.test${path}`, init),
      client: { address: "203.0.113.7", geo: { country_code: "GB", as_number: 2856 } },
      respondWith: (response) => void (respond = response),
      waitUntil: (promise) => void (waited++, work.push(promise)),
    };
    handler(event);
    const waitedInCallback = waited;
    const response = await respond;
    await Promise.all(work);
    return { response, waitedInCallback };
  };
  return { api, events, seen, call, origin: (fn: (request: Request) => Response) => void (origin = fn) };
}

const settingsWith = (routes: ClientSettings["routes"]): ClientSettings => ({
  version: 1,
  consent: "not_required",
  defaults: { off: [] },
  routing: { mode: "active", other: "ignore" },
  pages: [],
  screens: [],
  routes,
});

describe("Fastly Compute", () => {
  it("reads the settings once for the POP, and sends a route's event through the kairos backend", async () => {
    const s = service(
      { KAIROS_API_KEY: `ksk_fastly_${keys++}`, KAIROS_HASH_KEY: "hash-key" },
      settingsWith([
        {
          route: "POST /payees",
          mode: "track",
          type: "beneficiary_added",
          enforce: false,
          fields: { email: { from: "request.body", path: "$.email", kind: "email" } },
        },
      ]),
    );
    const post = () =>
      s.call("/payees", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "kairos_device=dev_1" },
        body: JSON.stringify({ email: "Ada@Example.com" }),
      });
    const { response, waitedInCallback } = await post();
    await post();
    expect(await response.text()).toBe("ok");
    expect(waitedInCallback).toBe(1);
    expect(s.api.filter((call) => call.endsWith("/v1/client-settings"))).toEqual(["kairos /v1/client-settings"]);
    expect(s.events.map((e) => [e.entities, e.properties.email, e.properties.country, e.properties.asn])).toEqual([
      [{ device: "dev_1", ip: "203.0.113.7" }, "ada@example.com", "GB", 2856],
      [{ device: "dev_1", ip: "203.0.113.7" }, "ada@example.com", "GB", 2856],
    ]);
    expect(
      await verifyEdge(hash, s.seen[0]!.headers.get("x-kairos-edge") ?? undefined, { method: "POST", path: "/payees" }),
    ).toEqual({});
  });

  it("sends every request on with no key, and adds the website script with a public key", async () => {
    const bare = service({}, settingsWith([]));
    expect(await (await bare.call("/")).response.text()).toBe("ok");
    expect(bare.api).toEqual([]);

    const site = service({ KAIROS_API_KEY: `ksk_fastly_${keys++}`, KAIROS_PUBLIC_KEY: "kpk_site" }, settingsWith([]));
    site.origin(() => new Response("<html><head></head></html>", { headers: { "content-type": "text/html" } }));
    expect(await (await site.call("/")).response.text()).toBe(
      '<script async src="https://kairos.finic.ai/kairos.js" data-api-key="kpk_site"></script>|text/html',
    );
  });
});
