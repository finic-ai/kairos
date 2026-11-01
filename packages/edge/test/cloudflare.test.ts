import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientRoute, ClientSettings, Decision } from "@finic-ai/kairos";
import { verifyEdge } from "@finic-ai/kairos/routes";
import { cloudflare } from "../src/cloudflare.js";

const hash = (value: string) => createHmac("sha256", "hash-key").update(value).digest("hex");
let keys = 0;

function worker(
  routes: (Partial<ClientRoute> & Pick<ClientRoute, "route" | "mode" | "type">)[],
  options: { decision?: Decision["decision"]; mode?: ClientSettings["routing"]["mode"]; publicKey?: string } = {},
) {
  const settings: ClientSettings = {
    version: 1,
    consent: "not_required",
    defaults: { off: [], sessionCookie: "sid" },
    routing: { mode: options.mode ?? "active", other: "ignore" },
    pages: [],
    screens: [],
    routes: routes.map((route) => ({ fields: {}, enforce: true, ...route })),
  };
  const api: { path: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    api.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/v1/client-settings") return Response.json(settings);
    if (path === "/v1/events") return Response.json({ accepted: 1 }, { status: 202 });
    return Response.json({
      decision: options.decision ?? "approve",
      risk_score: 80,
      reasons: ["r"],
      event_id: "evt_1",
    });
  });
  const seen: Request[] = [];
  let answer = (_request: Request) => new Response("ok");
  const env = {
    KAIROS_API_KEY: `ksk_test_${keys++}`,
    KAIROS_HASH_KEY: "hash-key",
    KAIROS_URL: "https://kairos.test",
    ...(options.publicKey ? { KAIROS_PUBLIC_KEY: options.publicKey } : {}),
  };
  const app = cloudflare<typeof env>({
    fetch: (request: Request) => {
      seen.push(request);
      return answer(request);
    },
  });
  const work: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void work.push(promise), passThroughOnException: () => {} };
  const settle = async () => {
    while (work.length) await Promise.all(work.splice(0));
  };
  const call = async (path: string, init: RequestInit = {}) => {
    const request = new Request(`https://shop.test${path}`, init);
    Object.assign(request, { cf: { country: "NG", asn: 37148 } });
    const response = await app.fetch(request, env, ctx);
    await settle();
    return response;
  };
  return {
    api,
    seen,
    call,
    origin: (fn: (request: Request) => Response) => void (answer = fn),
    events: () => api.filter((c) => c.path === "/v1/events").flatMap((c) => c.body.batch as any[]),
    decided: () => api.filter((c) => c.path === "/v1/events/decide").map((c) => c.body),
    warm: () => call("/"),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("the Cloudflare Worker", () => {
  it("sends a request that no route is for on as it came, without the x-kairos headers", async () => {
    const w = worker([{ route: "POST /payees", mode: "track", type: "beneficiary_added" }]);
    await w.warm();
    const response = await w.call("/about?x=1", { headers: { "x-kairos-edge": "forged", accept: "text/html" } });
    expect(await response.text()).toBe("ok");
    expect(w.seen[1]!.url).toBe("https://shop.test/about?x=1");
    expect(w.seen[1]!.headers.get("x-kairos-edge")).toBeNull();
    expect(w.seen[1]!.headers.get("accept")).toBe("text/html");
    expect(w.events()).toEqual([]);
  });

  it("sends the event of a route that tracks after the response, unless the middleware sends it", async () => {
    const w = worker([
      {
        route: "POST /payees/:id",
        mode: "track",
        type: "beneficiary_added",
        fields: {
          payeeId: { from: "request.param", path: "id" },
          email: { from: "request.body", path: "$.email", kind: "email" },
          bank: { from: "response.body", path: "$.bank" },
        },
      },
    ]);
    await w.warm();
    w.origin(() => Response.json({ bank: "GTB" }, { status: 201 }));
    const post = (headers: Record<string, string> = {}) =>
      w.call("/payees/p7", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
        body: JSON.stringify({ email: " Ada@Example.COM " }),
      });

    const response = await post({ cookie: "kairos_device=dev_1; kairos_visit=visit_1" });
    expect(await response.json()).toEqual({ bank: "GTB" });
    expect(await w.seen[1]!.json()).toEqual({ email: " Ada@Example.COM " });
    expect(
      await verifyEdge(hash, w.seen[1]!.headers.get("x-kairos-edge") ?? undefined, {
        method: "POST",
        path: "/payees/p7",
      }),
    ).toEqual({});
    expect(w.events().map(({ id: _id, ts: _ts, ...event }) => event)).toEqual([
      {
        type: "beneficiary_added",
        entities: { device: "dev_1", ip: "203.0.113.7", payee: "p7" },
        session: "visit_1",
        properties: {
          country: "NG",
          asn: 37148,
          email: "ada@example.com",
          bank: "GTB",
          source: "auto",
          http_method: "POST",
          http_route: "/payees/:id",
          http_status: "201",
        },
      },
    ]);

    w.origin(() => Response.json({ bank: "GTB" }, { status: 201, headers: { "x-kairos-tracked": "1" } }));
    const left = await post();
    expect(left.headers.get("x-kairos-tracked")).toBeNull();
    expect(await left.json()).toEqual({ bank: "GTB" });
    expect(w.events()).toHaveLength(1);
  });

  it("decides on the request: blocks before the origin, or passes the decision on to it", async () => {
    const route = {
      route: "POST /transfers",
      mode: "decide_request" as const,
      type: "transfer_requested",
      block: { status: 409, body: { error: "held" } },
    };
    const blocking = worker([route], { decision: "block" });
    await blocking.warm();
    const blocked = await blocking.call("/transfers", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    expect([blocked.status, await blocked.json()]).toEqual([409, { error: "held" }]);
    expect(blocking.seen).toHaveLength(1);
    expect(blocking.decided()).toMatchObject([{ type: "transfer_requested", entities: { ip: "203.0.113.7" } }]);

    const watching = worker([route], { decision: "block", mode: "monitor" });
    await watching.warm();
    expect(
      (await watching.call("/transfers", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } })).status,
    ).toBe(200);
    const passed = await verifyEdge(hash, watching.seen[1]!.headers.get("x-kairos-edge") ?? undefined, {
      method: "POST",
      path: "/transfers",
    });
    expect(passed?.decision).toMatchObject({ decision: "block", riskScore: 80, eventId: "evt_1" });
  });

  it("decides on the response: holds back a sign-in that is blocked, and sends the failed event of a 4xx", async () => {
    const w = worker(
      [
        {
          route: "POST /login",
          mode: "decide_response",
          type: "login_succeeded",
          failed: "login_failed",
          fields: { userId: { from: "response.body", path: "$.user" } },
        },
      ],
      { decision: "block" },
    );
    await w.warm();
    w.origin(() => Response.json({ user: "u1" }, { headers: { "set-cookie": "sid=new" } }));
    const blocked = await w.call("/login", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect(w.decided()).toMatchObject([{ type: "login_succeeded", entities: { user: "u1", ip: "203.0.113.7" } }]);

    w.origin(() => new Response(null, { status: 401 }));
    expect((await w.call("/login", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } })).status).toBe(
      401,
    );
    expect(w.events().map((e) => e.type)).toEqual(["login_failed"]);
  });

  it("sends every request on while the settings cannot be read, and when a decision fails", async () => {
    const w = worker([{ route: "POST /transfers", mode: "decide_request", type: "transfer_requested" }]);
    expect((await w.call("/transfers", { method: "POST" })).status).toBe(200);
    vi.stubGlobal("fetch", async (url: string) => {
      if (new URL(url).pathname === "/v1/events/decide") throw new TypeError("network down");
      return Response.json({ accepted: 1 }, { status: 202 });
    });
    expect(
      (await w.call("/transfers", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } })).status,
    ).toBe(200);
    expect(w.seen).toHaveLength(2);
  });

  it("adds the website script to HTML pages when there is a public key", async () => {
    vi.stubGlobal(
      "HTMLRewriter",
      class {
        private handler!: { element(element: { append(content: string): void }): void };
        on(_selector: string, handler: typeof this.handler) {
          this.handler = handler;
          return this;
        }
        transform(response: Response) {
          let added = "";
          this.handler.element({ append: (content) => void (added += content) });
          return new Response(
            response
              .body!.pipeThrough(new TextDecoderStream())
              .pipeThrough(
                new TransformStream({
                  transform: (chunk, controller) => controller.enqueue(chunk.replace("</head>", `${added}</head>`)),
                }),
              )
              .pipeThrough(new TextEncoderStream()),
            response,
          );
        }
      },
    );
    const w = worker([], { publicKey: 'kpk_"site' });
    w.origin(
      () => new Response("<html><head></head></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    expect(await (await w.call("/")).text()).toBe(
      '<html><head><script async src="https://kairos.test/kairos.js" data-api-key="kpk_&quot;site"></script></head></html>',
    );
    w.origin(() => Response.json({ ok: true }));
    expect(await (await w.call("/api")).json()).toEqual({ ok: true });
  });
});
