import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { metricRequest, type MetricRow } from "../src/modules/observe/schema";
import { bucketStart, computeMetric } from "../src/modules/observe/service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();

const period = { from: "2026-10-01T00:00:00Z", to: "2026-10-04T00:00:00Z" };
const ask = (query: Record<string, unknown>) => metricRequest.parse({ ...period, ...query });

const decision = (ts: string, outcome: string, extra: Partial<MetricRow> = {}): MetricRow => ({
  ts,
  outcome,
  action: "withdrawal@2",
  risk_score: 10,
  signals: [],
  subject: "user/u1",
  subject_type: "user",
  ...extra,
});
const decisions: MetricRow[] = [
  decision("2026-10-01T09:00:00Z", "approve", { risk_score: 4 }),
  decision("2026-10-01T10:00:00Z", "block", {
    risk_score: 96,
    signals: ["new_device", "new_payee"],
    subject: "user/u2",
    typology: "takeover",
  }),
  decision("2026-10-02T10:00:00Z", "approve", { risk_score: 20, action: "bank_transfer@1", subject: "user/u2" }),
  decision("2026-10-03T23:59:59Z", "review", { risk_score: 60, signals: ["new_device"], subject: "user/u3" }),
  decision("2026-10-04T00:00:00Z", "block"), // the end of the period is not inside it
];

describe("computing a metric", () => {
  it("counts, and gives one series when nothing is grouped", () => {
    const result = computeMetric(decisions, ask({ source: "decisions" }));
    expect(result).toMatchObject({
      total: 4,
      unit: "count",
      buckets: [],
      series: [{ key: "all", total: 4, values: [] }],
    });
  });

  it("puts each row in the bucket of its day, and keeps the empty days", () => {
    const result = computeMetric(decisions, ask({ source: "decisions", interval: "day" }));
    expect(result.buckets).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
    ]);
    expect(result.series[0]!.values).toEqual([2, 1, 1]);
    expect(computeMetric([], ask({ source: "decisions", interval: "day" })).series).toEqual([
      { key: "all", total: 0, values: [0, 0, 0] },
    ]);
  });

  it("groups by a field, largest first, and by signal with one row in several groups", () => {
    const byOutcome = computeMetric(decisions, ask({ source: "decisions", group_by: "outcome", interval: "day" }));
    expect(byOutcome.series).toEqual([
      { key: "approve", total: 2, values: [1, 1, 0] },
      { key: "block", total: 1, values: [1, 0, 0] },
      { key: "review", total: 1, values: [0, 0, 1] },
    ]);
    expect(
      computeMetric(decisions, ask({ source: "decisions", group_by: "action" })).series.map((s) => [s.key, s.total]),
    ).toEqual([
      ["withdrawal", 3],
      ["bank_transfer", 1],
    ]);
    expect(
      computeMetric(decisions, ask({ source: "decisions", group_by: "signal" })).series.map((s) => [s.key, s.total]),
    ).toEqual([
      ["new_device", 2],
      ["new_payee", 1],
    ]);
  });

  it("measures a share, an average and unique subjects", () => {
    expect(computeMetric(decisions, ask({ source: "decisions", measure: "share", field: "block" }))).toMatchObject({
      total: 25,
      unit: "percent",
    });
    expect(
      computeMetric(decisions, ask({ source: "decisions", measure: "share", field: "block", interval: "day" }))
        .series[0]!.values,
    ).toEqual([50, 0, 0]);
    expect(computeMetric(decisions, ask({ source: "decisions", measure: "avg", field: "risk_score" }))).toMatchObject({
      total: 45,
      unit: "number",
    });
    expect(computeMetric(decisions, ask({ source: "decisions", measure: "unique" })).total).toBe(3);
  });

  it("filters by action, signal, and the labels of the subject", () => {
    expect(
      computeMetric(decisions, ask({ source: "decisions", filters: { action: "withdrawal", signal: "new_device" } }))
        .total,
    ).toBe(2);
    const labelled = new Map([["user/u2", new Set(["fraud_confirmed"])]]);
    // Approved, and the subject was labelled: a miss.
    expect(
      computeMetric(
        decisions,
        ask({ source: "decisions", filters: { outcome: "approve", subject_label: "*" } }),
        labelled,
      ).total,
    ).toBe(1);
    expect(
      computeMetric(decisions, ask({ source: "decisions", filters: { subject_label: "fraud_confirmed" } }), labelled)
        .total,
    ).toBe(2);
    expect(
      computeMetric(decisions, ask({ source: "decisions", filters: { subject_label: "!" } }), labelled).total,
    ).toBe(2);
  });

  it("reads events: sums a property, counts unique entities, groups by a property", () => {
    const events: MetricRow[] = [
      {
        ts: "2026-10-01T09:00:00Z",
        type: "card_payment",
        entities: { user: "u1", merchant: "m1" },
        properties: { usd: 20, channel: "online" },
      },
      {
        ts: "2026-10-01T10:00:00Z",
        type: "card_payment",
        entities: { user: "u1", merchant: "m2" },
        properties: { usd: "30.5", channel: "online" },
      },
      {
        ts: "2026-10-02T10:00:00Z",
        type: "card_payment",
        entities: { user: "u2", merchant: "m1" },
        properties: { usd: 9, channel: "in_store" },
      },
      { ts: "2026-10-02T11:00:00Z", type: "login", entities: { user: "u2" }, properties: { usd: "n/a" } },
    ];
    const payments = { source: "events", filters: { event_type: "card_payment" } };
    expect(computeMetric(events, ask({ ...payments, measure: "sum", field: "usd" })).total).toBe(59.5);
    expect(computeMetric(events, ask({ ...payments, measure: "unique", field: "user" })).total).toBe(2);
    expect(computeMetric(events, ask({ ...payments, measure: "unique", field: "merchant" })).total).toBe(2);
    expect(
      computeMetric(events, ask({ ...payments, group_by: "property:channel" })).series.map((s) => [s.key, s.total]),
    ).toEqual([
      ["online", 2],
      ["in_store", 1],
    ]);
    expect(computeMetric(events, ask({ source: "events", group_by: "event_type" })).series.map((s) => s.key)).toEqual([
      "card_payment",
      "login",
    ]);
    expect(
      computeMetric(events, ask({ source: "events", filters: { property: { name: "channel", value: "in_store" } } }))
        .total,
    ).toBe(1);
  });

  it("counts the groups past the eighth together", () => {
    const rows: MetricRow[] = Array.from({ length: 12 }, (_, i) => ({
      ts: "2026-10-01T09:00:00Z",
      type: `t${String(i).padStart(2, "0")}`,
      entities: { user: "u" },
      properties: {},
    }));
    const series = computeMetric(rows, ask({ source: "events", group_by: "event_type" })).series;
    expect(series).toHaveLength(9);
    expect(series[8]).toMatchObject({ key: "Other (4)", total: 4 });
  });

  it("accepts several outcomes, and groups a score into bands in their own order", () => {
    expect(computeMetric(decisions, ask({ source: "decisions", measure: "share", field: "review,block" })).total).toBe(
      50,
    );
    expect(computeMetric(decisions, ask({ source: "decisions", filters: { outcome: "review,block" } })).total).toBe(2);
    expect(
      computeMetric(decisions, ask({ source: "decisions", group_by: "risk_band" })).series.map((s) => [s.key, s.total]),
    ).toEqual([
      ["0–9", 1],
      ["20–29", 1],
      ["60–69", 1],
      ["90–100", 1],
    ]);
  });

  it("starts a week on Monday", () => {
    // 7 October 2026 is a Wednesday.
    expect(new Date(bucketStart(Date.parse("2026-10-07T15:00:00Z"), "week")).toISOString()).toBe(
      "2026-10-05T00:00:00.000Z",
    );
    expect(new Date(bucketStart(Date.parse("2026-10-05T00:00:00Z"), "week")).toISOString()).toBe(
      "2026-10-05T00:00:00.000Z",
    );
  });
});

describe("metric and dashboard routes", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    await database.reset({ key_a: "workspace_a", key_b: "workspace_b" });
    app = createApp({
      repos: createRepositories(database.db),
      environments: environmentsRepository(database.db),
      accounts: tenancyRepository(database.db),
      decider: async () => ({
        id: "d",
        model: "grayson-1",
        answers: { hold: { type: "noul", value: true, probability: 0.97 } },
        usage: { input_tokens: 1 },
      }),
      now: () => new Date("2026-10-04T12:00:00Z"),
    });
  });
  const call = (method: string, path: string, body?: unknown, key = "key_a") =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ev = (id: string, type: string, ts: string, properties = {}) => ({
    id,
    type,
    ts,
    entities: { user: "u1" },
    properties,
  });

  it("answers a query from the stored data of one project, with the period before it", async () => {
    await call("POST", "/v1/events", {
      batch: [
        ev("a", "login", "2026-09-29T10:00:00Z"),
        ev("b", "login", "2026-10-01T10:00:00Z"),
        ev("c", "login", "2026-10-02T10:00:00Z"),
        ev("d", "card_payment", "2026-10-02T11:00:00Z", { usd: 12 }),
      ],
    });
    await call("PUT", "/v1/actions/payout", {
      subject: "user",
      hold: "Hold this payout?",
      reasons: { new_device: "A new device was used", new_payee: "The payee is new" },
    });
    const decided = await call("POST", "/v1/decide", {
      action: "payout",
      entities: { user: "u1" },
      ts: "2026-10-03T09:00:00Z",
    });
    expect([decided.status, (await decided.clone().json()).decision ?? (await decided.json()).error]).toEqual([
      200,
      "block",
    ]);
    await call("POST", "/v1/labels", {
      batch: [{ entity: { type: "user", id: "u1" }, label: "fraud_confirmed", ts: "2026-10-03T12:00:00Z" }],
    });

    const logins = await (
      await call("POST", "/v1/metrics/query", {
        ...period,
        source: "events",
        filters: { event_type: "login" },
        interval: "day",
        compare: true,
      })
    ).json();
    expect(logins).toMatchObject({
      total: 2,
      previous_total: 1,
      truncated: false,
      series: [{ key: "all", values: [1, 1, 0] }],
    });
    const blocked = await (
      await call("POST", "/v1/metrics/query", {
        ...period,
        source: "decisions",
        group_by: "outcome",
        filters: { subject_label: "*" },
      })
    ).json();
    expect(blocked.series).toEqual([{ key: "block", total: 1, values: [] }]);
    expect(
      (await (await call("POST", "/v1/metrics/query", { ...period, source: "labels", group_by: "label" })).json())
        .series[0],
    ).toMatchObject({ key: "fraud_confirmed", total: 1 });
    expect(
      (await (await call("POST", "/v1/metrics/query", { ...period, source: "events" }, "key_b")).json()).total,
    ).toBe(0);

    expect((await call("POST", "/v1/metrics/query", { ...period, source: "tables" })).status).toBe(400);
    expect(
      (await call("POST", "/v1/metrics/query", { source: "events", from: period.to, to: period.from })).status,
    ).toBe(400);

    const options = await (await call("GET", "/v1/metrics/options?event_type=card_payment")).json();
    expect(options).toMatchObject({
      actions: ["payout"],
      signals: ["new_device", "new_payee"],
      labels: ["fraud_confirmed"],
      entity_types: ["user"],
      event_properties: [{ name: "usd", numeric: true }],
    });
    expect(options.event_types).toEqual(expect.arrayContaining(["login", "card_payment"]));
  });

  it("creates, changes, lists and deletes a dashboard, for one project only", async () => {
    const tile = {
      id: "t1",
      title: "Block rate",
      view: "line",
      size: "m",
      query: { source: "decisions", measure: "share", field: "block" },
    };
    const created = await (await call("POST", "/v1/dashboards", { name: " Payouts ", tiles: [tile] })).json();
    expect(created).toMatchObject({
      name: "Payouts",
      range: "30d",
      visibility: "workspace",
      owner: null,
      mine: false,
      can_manage: true,
      created: "2026-10-04T12:00:00.000Z",
    });
    // A size from before widths were numbers becomes a width.
    expect(created.tiles[0]).toMatchObject({ w: 6 });
    expect(created.tiles[0]).not.toHaveProperty("size");
    expect((await call("POST", "/v1/dashboards", { name: "x", visibility: "private" })).status).toBe(400);
    expect(created.tiles[0].query.filters).toEqual({});
    expect(created.id).toMatch(/^dash_/);

    const changed = await (
      await call("PUT", `/v1/dashboards/${created.id}`, {
        name: "Payouts",
        range: "7d",
        tiles: [tile, { ...tile, id: "t2", view: "list", size: undefined, w: 4 }],
      })
    ).json();
    expect([changed.range, changed.tiles.map((t: any) => t.w), changed.created]).toEqual([
      "7d",
      [6, 4],
      created.created,
    ]);
    expect((await (await call("GET", "/v1/dashboards")).json()).dashboards.map((d: any) => d.name)).toEqual([
      "Payouts",
    ]);
    expect((await (await call("GET", "/v1/dashboards", undefined, "key_b")).json()).dashboards).toEqual([]);
    expect((await call("GET", `/v1/dashboards/${created.id}`, undefined, "key_b")).status).toBe(404);

    expect((await call("POST", "/v1/dashboards", { name: "x", tiles: [{ ...tile, view: "pie" }] })).status).toBe(400);
    // A tile can name the page its title opens, from a fixed list.
    const linked = await (
      await call("PUT", `/v1/dashboards/${created.id}`, { name: "Payouts", tiles: [{ ...tile, link: "entities" }] })
    ).json();
    expect(linked.tiles[0].link).toBe("entities");
    expect(
      (
        await call("PUT", `/v1/dashboards/${created.id}`, {
          name: "Payouts",
          tiles: [{ ...tile, link: "https://example.com" }],
        })
      ).status,
    ).toBe(400);
    expect((await call("PUT", "/v1/dashboards/dash_missing", { name: "x" })).status).toBe(404);
    await call("DELETE", `/v1/dashboards/${created.id}`);
    expect((await call("GET", `/v1/dashboards/${created.id}`)).status).toBe(404);
  });
});
