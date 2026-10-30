import type { Decider } from "@kairos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { fileURLToPath } from "node:url";
import { loadEntityTemplates } from "../src/modules/catalog/service";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const repos = createRepositories(database.db);
const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let app: ReturnType<typeof createApp>;
let cookie: string;
let workspace: string;

const decider: Decider = async () => {
  throw new Error("No decision is made in these tests");
};

const call = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Kairos-Workspace": workspace },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

const event = (id: string, type: string, days: number, entities: Record<string, string>, properties = {}) => ({
  id,
  type,
  ts: ago(days),
  entities,
  properties,
});

const user = {
  kind: "person",
  facts: [
    {
      name: "payments_30d",
      label: "Payments in 30 days",
      source: "events",
      measure: "count",
      filters: { event_type: "payment" },
      window: "30d",
    },
    {
      name: "paid_30d",
      label: "Paid in 30 days",
      source: "events",
      measure: "sum",
      field: "amount",
      filters: { event_type: "payment" },
      window: "30d",
      format: "money",
      currency: "GBP",
    },
    {
      name: "deposits_7d",
      label: "Deposits this week",
      source: "events",
      measure: "sum",
      field: "amount",
      filters: { event_type: "deposit" },
      window: "7d",
      usual: "63d",
    },
    { name: "devices", label: "Devices", source: "events", measure: "unique", field: "device" },
    { name: "first_seen", label: "First seen", source: "events", measure: "first" },
    { name: "labels", label: "Labels", source: "labels", measure: "count" },
    { name: "cases", label: "Cases", source: "cases", measure: "count" },
  ],
  lists: [
    {
      name: "payments",
      label: "Payments",
      source: "events",
      filters: { event_type: ["payment"] },
      columns: [
        "ts",
        { field: "event.amount", label: "Amount", format: "money", currency: "event.currency" },
        "event.payee",
      ],
    },
    {
      name: "devices",
      label: "Devices",
      source: "linked",
      entity_type: "device",
      columns: ["id", "name", "events", "last_seen"],
    },
  ],
};

beforeEach(async () => {
  await database.reset();
  app = createApp({
    repos,
    accounts: tenancyRepository(database.db),
    environments: environmentsRepository(database.db),
    decider,
    now: () => NOW,
  });
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "correct horse", name: "Owner" }),
  });
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  workspace = ((await response.json()) as any).workspaces[0].id;

  expect((await call("PUT", "/v1/entity-types/user", user)).status).toBe(200);
  expect((await call("PUT", "/v1/entity-types/device", { display: { fields: ["model"] } })).status).toBe(200);
  const stored = await call("POST", "/v1/events", {
    batch: [
      event("p1", "payment", 1, { user: "u1", device: "d1" }, { amount: 100, currency: "GBP", payee: "acme" }),
      event("p2", "payment", 2, { user: "u1", device: "d2" }, { amount: "250.5", currency: "EUR", payee: "bolt" }),
      event("p3", "payment", 40, { user: "u1", device: "d1" }, { amount: 999 }),
      event("p4", "payment", 1, { user: "u2", device: "d1" }, { amount: 5 }),
      // 700 this week; 450 in the 56 days before it, which is 56.25 a week.
      event("dep1", "deposit", 3, { user: "u1" }, { amount: 700 }),
      event("dep2", "deposit", 20, { user: "u1" }, { amount: 200 }),
      event("dep3", "deposit", 50, { user: "u1" }, { amount: 250 }),
      event("dep4", "deposit", 70, { user: "u1" }, { amount: 9999 }),
      event("login", "login", 5, { user: "u1", device: "d3" }),
    ],
  });
  expect(stored.status, JSON.stringify(stored.body)).toBe(202);
  await call("PUT", "/v1/objects", {
    batch: [{ type: "device", id: "d1", properties: { model: "Pixel 8" } }],
  });
  await call("POST", "/v1/labels", { batch: [{ entity: { type: "user", id: "u1" }, label: "vip", ts: ago(1) }] });
});

describe("facts of an entity", () => {
  it("counts, sums, compares with the usual, and finds the first record", async () => {
    const answer = await call("GET", "/v1/entities/user/u1/facts");
    expect(answer.status).toBe(200);
    const facts = Object.fromEntries(answer.body.facts.map((f: any) => [f.name, f]));
    expect(facts.payments_30d).toMatchObject({ value: 2, window: "30d", label: "Payments in 30 days" });
    expect(facts.paid_30d).toMatchObject({ value: 350.5, format: "money", currency: "GBP" });
    expect(facts.deposits_7d).toMatchObject({ value: 700, usual: 56.25, times_usual: 12.4 });
    expect(facts.devices.value).toBe(3);
    expect(facts.first_seen.value).toBe(ago(70));
    expect(facts.labels.value).toBe(1);
    expect(facts.cases.value).toBe(0);
  });

  it("gives no facts for a type with none, and refuses a fact Kairos cannot work out", async () => {
    expect((await call("GET", "/v1/entities/device/d1/facts")).body).toEqual({ facts: [] });
    const wrong = await call("PUT", "/v1/entity-types/user", {
      facts: [{ name: "x", label: "X", source: "labels", measure: "sum", field: "amount" }],
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toContain("facts[0].measure must be one of count, first, last for labels");
  });
});

describe("lists of an entity", () => {
  it("pages through the records, newest first, with the columns asked for", async () => {
    const first = await call("GET", "/v1/entities/user/u1/lists/payments?limit=2");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      name: "payments",
      total: 3,
      columns: [
        { field: "ts", label: "When" },
        { field: "event.amount", label: "Amount", format: "money", currency: "event.currency" },
        { field: "event.payee", label: "payee" },
      ],
    });
    expect(first.body.rows).toEqual([
      {
        id: "p1",
        ts: ago(1),
        link: { kind: "event", id: "p1" },
        values: { ts: ago(1), "event.amount": 100, "event.currency": "GBP", "event.payee": "acme" },
      },
      {
        id: "p2",
        ts: ago(2),
        link: { kind: "event", id: "p2" },
        values: { ts: ago(2), "event.amount": "250.5", "event.currency": "EUR", "event.payee": "bolt" },
      },
    ]);
    const next = await call("GET", "/v1/entities/user/u1/lists/payments?limit=2&offset=2");
    expect(next.body.rows.map((r: any) => r.id)).toEqual(["p3"]);
    expect((await call("GET", "/v1/entities/user/u1/lists/payments?q=bolt")).body.rows.map((r: any) => r.id)).toEqual([
      "p2",
    ]);
  });

  it("lists the linked entities of a type, by their display names", async () => {
    const devices = await call("GET", "/v1/entities/user/u1/lists/devices");
    expect(devices.body.total).toBe(3);
    expect(devices.body.rows.map((r: any) => [r.id, r.values.name, r.values.events, r.link])).toEqual([
      ["d1", "Pixel 8", 2, { kind: "entity", type: "device", id: "d1" }],
      ["d2", null, 1, { kind: "entity", type: "device", id: "d2" }],
      ["d3", null, 1, { kind: "entity", type: "device", id: "d3" }],
    ]);
  });

  it("says when a type has no such list", async () => {
    expect((await call("GET", "/v1/entities/user/u1/lists/nope")).status).toBe(404);
  });

  it("gives one event of a row, with the decision it started", async () => {
    const found = await call("GET", "/v1/events/p2");
    expect(found.body).toMatchObject({
      id: "p2",
      type: "payment",
      ts: ago(2),
      entities: { user: "u1", device: "d2" },
      properties: { amount: "250.5", payee: "bolt" },
      decision: null,
    });
    expect((await call("GET", "/v1/events/nope")).status).toBe(404);
  });
});

describe("properties shown as images", () => {
  it("reads an image property through Kairos, by the format of its type", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    await call("PUT", "/v1/entity-types/user", { display: { formats: { photo: "image", logo: "image" } } });
    await call("PUT", "/v1/objects", {
      batch: [
        {
          type: "user",
          id: "u1",
          properties: {
            photo: `data:image/png;base64,${png.toString("base64")}`,
            logo: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
          },
        },
      ],
    });
    const media = (property: string) =>
      app.request(`/v1/entities/user/u1/media/${property}`, {
        headers: { Cookie: cookie, "X-Kairos-Workspace": workspace },
      });
    const photo = await media("photo");
    expect([photo.status, photo.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect(Buffer.from(await photo.arrayBuffer())).toEqual(png);
    expect((await media("logo")).status).toBe(415);
    expect((await media("none")).status).toBe(404);
    const wrong = await call("PUT", "/v1/entity-types/user", { display: { formats: { photo: "picture" } } });
    expect(wrong.body.error.message).toContain("display.formats.photo must be one of");
  });
});

describe("entity type templates", () => {
  it("are valid definitions, each with facts and lists", () => {
    const templates = loadEntityTemplates(fileURLToPath(new URL("../../../templates", import.meta.url)));
    expect(templates.map((t) => t.type)).toEqual(["beneficiary", "device", "merchant", "user"]);
    for (const t of templates) expect([t.type, t.facts!.length > 0, t.lists!.length > 0]).toEqual([t.type, true, true]);
  });

  it("are listed for the console", async () => {
    app = createApp({
      repos,
      accounts: tenancyRepository(database.db),
      environments: environmentsRepository(database.db),
      decider,
      now: () => NOW,
      entityTemplates: [{ type: "user", kind: "person" }],
    });
    expect((await call("GET", "/v1/entity-templates")).body).toEqual({ templates: [{ type: "user", kind: "person" }] });
  });
});
