import { Hono, type Context } from "hono";
import { invalid } from "../../platform/error";
import { bounded, error, parse, type Env } from "../../platform/http";
import { clientIp, normalizeIp } from "../../platform/network";
import type { Repositories } from "../../repositories";
import { eventsBody } from "./schema";
import { record, session, track } from "./service";
import type { EventVia } from "../../types";
import { EventsService } from "../../services/event.service";

/** The list counts its events up to this many, and says when there are more. */
const MAX_COUNTED = 10_000;

/** The chart of events has at most this many bars, and names this many types; the rest are one series. */
const MAX_STEPS = 60;
const MAX_SERIES = 5;
const DAY = 86_400;
const STEPS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, DAY, 7 * DAY, 30 * DAY, 90 * DAY, 365 * DAY];

const moment = (name: string, value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(`${name}: not a date and time`);
  return date.toISOString();
};

const eventFilter = (q: Record<string, string>) => ({
  ...(q.type ? { type: q.type } : {}),
  ...(q.status ? { status: q.status } : {}),
  ...(q.entity_type && q.entity_id ? { entity: { type: q.entity_type, id: q.entity_id } } : {}),
});

const OUTCOMES = ["any", "approve", "step_up", "review", "block"];

/** How the request came: a public key is in a web page, so its events never start an automatic decision. */
export const sourceOf = (c: Context<Env>): EventVia =>
  c.get("publicKey") ? "public" : c.get("userId") ? "console" : "key";

export type IngestDeps = Pick<Repositories, "db" | "events" | "transaction"> & {
  now: () => Date;
  onQueued?: () => void;
  trustProxy?: boolean;
};

export function eventRoutes({ db, events, transaction, now, onQueued, trustProxy }: IngestDeps) {
  const app = new Hono<Env>();

  app.post("/events", async (c) => {
    const body = await parse(c, eventsBody);
    if ("response" in body) return body.response;
    // A browser cannot know its own public address, so the events of a public key get it here.
    const address = c.get("publicKey") ? clientIp(c, trustProxy) : undefined;
    const ip = address ? normalizeIp(address) : undefined;
    const batch = body.data.batch.map((e) => ({
      ...e,
      ts: new Date(e.ts).toISOString(),
      ...(ip && !e.entities.ip ? { entities: { ...e.entities, ip } } : {}),
    }));
    const stored = await track(
      { transaction },
      c.get("workspaceId"),
      c.get("environmentId"),
      batch,
      now().toISOString(),
      sourceOf(c),
    );
    if (stored.queued > 0) onQueued?.();
    await c.var.logActivity({
      action: "event.sent",
      resource: { type: "event", ...(batch.length === 1 ? { id: batch[0]!.id } : {}) },
      details: { count: batch.length, accepted: stored.accepted, duplicates: stored.duplicates },
    });
    return c.json({ accepted: stored.accepted, duplicates: stored.duplicates }, 202);
  });

  app.get("/events", async (c) => {
    const q = c.req.query();
    const limit = bounded(q.limit, 50, 1, 200);
    const offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
    const from = moment("from", q.from);
    const to = moment("to", q.to);
    const filter = { ...eventFilter(q), ...(from ? { from } : {}), ...(to ? { to } : {}) };
    const scoped = new EventsService(db, { workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
    const [found, total] = await Promise.all([
      scoped.listMatching(filter, limit, offset),
      scoped.countMatching(filter, MAX_COUNTED),
    ]);
    return c.json({ events: found, total, total_capped: total >= MAX_COUNTED });
  });

  app.get("/event-counts", async (c) => {
    const q = c.req.query();
    const filter = eventFilter(q);
    const scoped = new EventsService(db, { workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
    const to = moment("to", q.to) ?? now().toISOString();
    const from = moment("from", q.from) ?? (await scoped.firstTs({ ...filter, to }));
    if (!from || from >= to) return c.json({ buckets: [], step_seconds: STEPS[0], series: [], total: 0 });

    const seconds = (Date.parse(to) - Date.parse(from)) / 1000;
    const step = STEPS.find((s) => seconds / s <= MAX_STEPS) ?? Math.ceil(seconds / MAX_STEPS);
    const first = Math.floor(Date.parse(from) / 1000 / step);
    const last = Math.floor((Date.parse(to) - 1) / 1000 / step);
    const buckets = Array.from({ length: last - first + 1 }, (_, i) =>
      new Date((first + i) * step * 1000).toISOString(),
    );

    const byType = new Map<string, number[]>();
    for (const r of await scoped.countOverTime({ ...filter, from, to }, step)) {
      const values = byType.get(r.type) ?? buckets.map(() => 0);
      values[r.step - first] = r.n;
      byType.set(r.type, values);
    }
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    const ranked = [...byType]
      .map(([key, values]) => ({ key, total: sum(values), values }))
      .sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
    const rest = ranked.slice(MAX_SERIES);
    const series = [
      ...ranked.slice(0, MAX_SERIES),
      ...(rest.length
        ? [
            {
              key: `Other (${rest.length})`,
              total: sum(rest.map((s) => s.total)),
              values: buckets.map((_, i) => sum(rest.map((s) => s.values[i]!))),
            },
          ]
        : []),
    ];
    return c.json({ buckets, step_seconds: step, series, total: sum(series.map((s) => s.total)) });
  });

  app.get("/event-arrivals", async (c) => {
    const q = c.req.query();
    const after = moment("after", q.after);
    if (!after) return c.json({ events: [], cursor: now().toISOString() });
    const scoped = new EventsService(db, { workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
    return c.json(await scoped.listArrivals(eventFilter(q), after, bounded(q.limit, 200, 1, 500)));
  });

  app.get("/events/:id", async (c) => {
    const found = await events.findEvent(c.get("workspaceId"), c.get("environmentId"), c.req.param("id"));
    return found ? c.json(found) : error(c, 404, "not_found", `No event "${c.req.param("id")}"`);
  });

  app.get("/records/:id", async (c) =>
    c.json(await record({ db }, c.get("workspaceId"), c.get("environmentId"), c.req.param("id"), now())),
  );

  app.get("/sessions", async (c) => {
    const q = c.req.query();
    const limit = bounded(q.limit, 50, 1, 200);
    const offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
    const { sessions, total } = await events.listSessions(c.get("workspaceId"), c.get("environmentId"), {
      q: q.q || undefined,
      outcome: OUTCOMES.includes(q.outcome ?? "") ? q.outcome : undefined,
      limit,
      offset,
    });
    return c.json({ sessions, total, next_offset: sessions.length === limit ? offset + limit : null });
  });

  app.get("/sessions/:id", async (c) =>
    c.json(
      await session(
        { db, events },
        c.get("workspaceId"),
        c.get("environmentId"),
        c.req.param("id"),
        now(),
        bounded(c.req.query("limit"), 500, 1, 2000),
      ),
    ),
  );

  return app;
}
