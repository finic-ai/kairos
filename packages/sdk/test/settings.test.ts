import { describe, expect, it } from "vitest";
import {
  isCardNumber,
  matchPath,
  matchRoute,
  MAX_BODY_BYTES,
  normalizePhone,
  readableBody,
  readPath,
  routeProperties,
  type RequestParts,
} from "../src/settings.js";
import type { ClientRoute, ClientSettings } from "../src/types.js";

const settings = (routes: Partial<ClientRoute>[], patch: Partial<ClientSettings> = {}): ClientSettings => ({
  version: 1,
  consent: "not_required",
  defaults: { off: [], country: "GB" },
  routing: { mode: "monitor", other: "ignore" },
  pages: [],
  screens: [],
  routes: routes.map((r) => ({ route: "POST /", mode: "track", type: "t", fields: {}, enforce: false, ...r })),
  ...patch,
});

const parts = (patch: Partial<RequestParts> = {}): RequestParts => ({
  query: () => undefined,
  header: () => undefined,
  cookie: () => undefined,
  params: {},
  ...patch,
});

describe("routes", () => {
  it("match a path with parameters and a wildcard", () => {
    expect(matchPath("/payees/:id/verify", "/payees/p%207/verify/")).toEqual({ id: "p 7" });
    expect(matchPath("/payees/:id", "/payees")).toBeUndefined();
    expect(matchPath("/payees/:id", "/payees/p7/verify")).toBeUndefined();
    expect(matchPath("/account/*", "/account/security/keys")).toEqual({});
    expect(matchPath("/", "/")).toEqual({});
  });

  it("match the first route with the method, and none when routing is off", () => {
    const s = settings([
      { route: "GET /payees/:id", type: "viewed" },
      { route: "POST /payees/:id", type: "first" },
      { route: "POST /payees/*", type: "second" },
    ]);
    expect(matchRoute(s, "post", "/payees/p7")).toMatchObject({ route: { type: "first" }, params: { id: "p7" } });
    expect(matchRoute(s, "DELETE", "/payees/p7")).toBeUndefined();
    expect(matchRoute({ ...s, routing: { mode: "off", other: "ignore" } }, "POST", "/payees/p7")).toBeUndefined();
  });
});

describe("fields", () => {
  it("read the JSONPath that names one value", () => {
    const body = { payee: { id: "p7" }, items: [{ sku: "A" }], "first name": "Ada" };
    expect(readPath(body, "$.payee.id")).toBe("p7");
    expect(readPath(body, "$.items[0].sku")).toBe("A");
    expect(readPath(body, "$['first name']")).toBe("Ada");
    expect(readPath(body, "$.missing.deeper")).toBeUndefined();
    expect(readPath(body, "payee.id")).toBeUndefined();
  });

  it("read a body only when it is JSON of a size that can be read", () => {
    expect(readableBody("application/json; charset=utf-8", undefined)).toBe(true);
    expect(readableBody("application/vnd.api+json", String(MAX_BODY_BYTES))).toBe(true);
    expect(readableBody("application/json", String(MAX_BODY_BYTES + 1))).toBe(false);
    expect(readableBody("multipart/form-data; boundary=x", "10")).toBe(false);
    expect(readableBody("image/png", "10")).toBe(false);
    expect(readableBody(undefined, "10")).toBe(false);
  });

  it("know a card number by its length and the Luhn check", () => {
    expect(isCardNumber("4111 1111 1111 1111")).toBe(true);
    expect(isCardNumber("4111-1111-1111-1112")).toBe(false);
    expect(isCardNumber("123456")).toBe(false);
  });

  it("write a phone number in E.164 where they can", () => {
    expect(normalizePhone("07700 900123", "GB")).toBe("+447700900123");
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("0044 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("06 1234 5678", "IT")).toBe("+390612345678");
    expect(normalizePhone("(555) 010-0199")).toBe("5550100199");
  });

  it("make the properties of an event, and leave out what must not be sent", async () => {
    const s = settings([], { defaults: { off: ["address"], country: "GB" } });
    const route = settings([
      {
        fields: {
          email: { from: "request.body", path: "$.email", kind: "email" },
          phone: { from: "request.body", path: "$.phone", kind: "phone" },
          address: { from: "request.body", path: "$.address", kind: "address" },
          card: { from: "request.body", path: "$.card" },
          payeeId: { from: "request.param", path: "id" },
          plan: { from: "request.query", path: "plan" },
          method: { value: "password" },
          missing: { from: "request.header", path: "x-missing" },
          account: { from: "request.body", path: "$.account", kind: "hmac" },
          sid: { from: "request.cookie", path: "sid" },
        },
      },
    ]).routes[0]!;
    const request = parts({
      body: {
        email: " Ada@Example.COM ",
        phone: "07700 900123",
        address: "1 High St",
        card: "4111111111111111",
        account: "12345678",
      },
      params: { id: "p7" },
      query: (name) => (name === "plan" ? "gold" : undefined),
      cookie: (name) => (name === "sid" ? "secret-session" : undefined),
    });

    expect(await routeProperties(route, request, s)).toEqual({
      properties: { email: "ada@example.com", phone: "+447700900123", payeeId: "p7", plan: "gold", method: "password" },
      problems: [
        'POST /: the field "account" is sent only as a hash, and there is no hash key.',
        'POST /: the field "sid" is sent only as a hash, and there is no hash key.',
      ],
    });
    const hashed = await routeProperties(route, request, s, (value) => `h(${value})`);
    expect(hashed.properties).toMatchObject({ account: "h(12345678)", sid: "h(secret-session)" });
    expect(hashed.problems).toEqual([]);
  });
});
