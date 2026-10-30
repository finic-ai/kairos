import { Hono, type Context } from "hono";
import { bounded, error, parse, type Env } from "../../platform/http";
import type { Repositories } from "../../repositories";
import { eventsBody } from "./schema";
import { record, session, track } from "./service";
import type { EventVia } from "../../types";

const OUTCOMES = ["any", "approve", "step_up", "review", "block"];

/** How the request came: a public key is in a web page, so its events never start an automatic decision. */
export const sourceOf = (c: Context<Env>): EventVia =>
  c.get("publicKey") ? "public" : c.get("userId") ? "console" : "key";

export type IngestDeps = Pick<Repositories, "db" | "events" | "transaction"> & {
  now: () => Date;
  onQueued?: () => void;
};

export function eventRoutes({ db, events, transaction, now, onQueued }: IngestDeps) {
  const app = new Hono<Env>();

  app.post("/events", async (c) => {
    const body = await parse(c, eventsBody);
    if ("response" in body) return body.response;
    const batch = body.data.batch.map((e) => ({ ...e, ts: new Date(e.ts).toISOString() }));
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
