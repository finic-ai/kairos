import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientRoute, ClientSettings, Decision } from "@finic-ai/kairos";
import { lambdaEdge, type CloudFrontRequest, type CloudFrontResponse } from "../src/lambda.js";

let keys = 0;

function distribution(
  routes: (Partial<ClientRoute> & Pick<ClientRoute, "route" | "mode" | "type">)[],
  decision: Decision["decision"] = "approve",
) {
  const settings: ClientSettings = {
    version: 1,
    consent: "not_required",
    defaults: { off: [] },
    routing: { mode: "active", other: "ignore" },
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
    return Response.json({ decision, risk_score: 90, reasons: [] });
  });
  const kairos = lambdaEdge({ apiKey: `ksk_lambda_${keys++}`, hashKey: "hash-key" });
  return {
    kairos,
    events: () => api.filter((c) => c.path === "/v1/events").flatMap((c) => c.body.batch as any[]),
    decided: () => api.filter((c) => c.path === "/v1/events/decide").map((c) => c.body),
  };
}

const viewer = (
  method: string,
  uri: string,
  body?: unknown,
  headers: Record<string, string> = {},
): CloudFrontRequest => {
  const all = { host: "shop.test", "cloudfront-viewer-country": "NG", ...headers };
  return {
    clientIp: "203.0.113.7",
    method,
    uri,
    querystring: "",
    headers: Object.fromEntries(Object.entries(all).map(([name, value]) => [name, [{ key: name, value }]])),
    ...(body === undefined
      ? {}
      : {
          body: {
            inputTruncated: false,
            action: "read-only",
            encoding: "base64" as const,
            data: Buffer.from(JSON.stringify(body)).toString("base64"),
          },
        }),
  };
};
const json = { "content-type": "application/json" };
const answer = (status: number, headers: Record<string, string> = {}): CloudFrontResponse => ({
  status: String(status),
  headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [{ key: name, value }]])),
});

afterEach(() => vi.unstubAllGlobals());

describe("Lambda@Edge", () => {
  it("passes the fields of the request's body to the origin response function, which sends the event", async () => {
    const d = distribution([
      {
        route: "POST /payees",
        mode: "track",
        type: "beneficiary_added",
        fields: { email: { from: "request.body", path: "$.email", kind: "email" } },
      },
    ]);
    const request = viewer("POST", "/payees", { email: " Ada@Example.COM " }, { ...json, "x-kairos-edge": "forged" });
    const forwarded = (await d.kairos.originRequest({ Records: [{ cf: { request } }] })) as CloudFrontRequest;
    expect(forwarded.headers["x-kairos-edge"]![0]!.value).not.toBe("forged");
    expect(d.events()).toEqual([]);

    const tracked = await d.kairos.originResponse({ Records: [{ cf: { request: forwarded, response: answer(201) } }] });
    expect(tracked.status).toBe("201");
    expect(d.events().map(({ id: _id, ts: _ts, ...event }) => event)).toEqual([
      {
        type: "beneficiary_added",
        entities: { ip: "203.0.113.7" },
        properties: {
          country: "NG",
          email: "ada@example.com",
          source: "auto",
          http_method: "POST",
          http_route: "/payees",
          http_status: "201",
        },
      },
    ]);

    const left = await d.kairos.originResponse({
      Records: [{ cf: { request: forwarded, response: answer(201, { "x-kairos-tracked": "1" }) } }],
    });
    expect(left.headers["x-kairos-tracked"]).toBeUndefined();
    expect(d.events()).toHaveLength(1);
  });

  it("answers in place of the origin, and of its response, with nothing cached", async () => {
    const before = distribution(
      [{ route: "POST /transfers", mode: "decide_request", type: "transfer_requested" }],
      "block",
    );
    const blocked = (await before.kairos.originRequest({
      Records: [{ cf: { request: viewer("POST", "/transfers", { amount: 900 }, json) } }],
    })) as CloudFrontResponse;
    expect(blocked).toEqual({
      status: "403",
      headers: {
        "cache-control": [{ key: "Cache-Control", value: "no-store" }],
        "content-type": [{ key: "Content-Type", value: "application/json" }],
      },
      body: JSON.stringify({ error: "blocked" }),
    });

    const after = distribution(
      [
        {
          route: "POST /login",
          mode: "decide_response",
          type: "login_succeeded",
          fields: { userId: { from: "response.header", path: "x-user" } },
        },
      ],
      "block",
    );
    const request = (await after.kairos.originRequest({
      Records: [{ cf: { request: viewer("POST", "/login") } }],
    })) as CloudFrontRequest;
    const held = await after.kairos.originResponse({
      Records: [{ cf: { request, response: answer(200, { "set-cookie": "sid=new", "x-user": "u1" }) } }],
    });
    expect(held.status).toBe("403");
    expect(held.headers["set-cookie"]).toBeUndefined();
    expect(after.decided()).toMatchObject([{ type: "login_succeeded", entities: { user: "u1", ip: "203.0.113.7" } }]);
  });

  it("sends the request and the response on when Kairos cannot be read", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    const kairos = lambdaEdge(async () => ({ apiKey: `ksk_lambda_${keys++}`, hashKey: "hash-key" }));
    const request = viewer("POST", "/transfers");
    expect(await kairos.originRequest({ Records: [{ cf: { request } }] })).toBe(request);
    const response = answer(200);
    expect(await kairos.originResponse({ Records: [{ cf: { request, response } }] })).toBe(response);
  });
});
