import {
  CASE_PRIORITIES,
  CASE_STATUSES,
  validateView,
  type CasePriority,
  type CaseStatus,
  type CaseView,
  type QueueDefinition,
} from "@kairos/core";
import { Hono, type Context } from "hono";
import type { Webhooks } from "../../context";
import { bounded, error, parse, type Env } from "../../platform/http";
import { invalid } from "../../platform/error";
import type { Repositories } from "../../repositories";
import { assignBody, bulkBody, noteBody, queueBody, reopenBody, resolveBody } from "./schema";
import type { ViewTemplate } from "./types";
import { MEDIA_ERROR, mediaHeaders } from "./libs";
import {
  addNote,
  assignCase,
  bulkCases,
  caseDetail,
  caseTimeline,
  caseMedia,
  caseView,
  caseViewList,
  checkPoint,
  recordViewed,
  createQueue,
  deleteQueue,
  findQueue,
  listQueues,
  queueCases,
  queueView,
  reopenCase,
  resolveCase,
  saveQueue,
  testQueue,
} from "./service";

export type CasesDeps = { repos: Repositories; now: () => Date; webhooks?: Webhooks; templates?: ViewTemplate[] };

const STATUSES = new Set<string>([...CASE_STATUSES, "unresolved", "open_decisions"]);
const PRIORITIES = new Set<string>(CASE_PRIORITIES);

export function caseRoutes({ repos, now, webhooks, templates = [] }: CasesDeps) {
  const app = new Hono<Env>();
  const { db } = repos;
  const scopeOf = (c: Context<Env>) => ({ workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
  /** Who did it, as a decision's resolution names a person: their email address, or the `by` of a key, or "API". */
  const actorOf = (c: Context<Env>, by?: string) => (c.get("userId") ? c.get("user").email : (by ?? "API"));

  /** Work that queued webhook deliveries: the worker sends them now, not at its next tick. */
  const sent = <T extends { queued: number }>(done: T) => (done.queued > 0 && webhooks?.worker?.wake(), done);
  const logCase = (c: Context<Env>, verb: string, details?: Record<string, unknown>) =>
    c.var.logActivity({
      action: `case.${verb}`,
      resource: { type: "case", id: c.req.param("id")! },
      ...(details ? { details } : {}),
    });

  app.get("/queues", async (c) => c.json({ queues: await listQueues(db, scopeOf(c), c.get("userId"), now()) }));

  app.post("/queues", async (c) => {
    const body = await parse(c, queueBody);
    if ("response" in body) return body.response;
    const queue = await createQueue(db, scopeOf(c), body.data as QueueDefinition, c.get("userId"), now());
    await c.var.logActivity({
      action: "queue.created",
      resource: { type: "queue", id: queue.id },
      details: { name: body.data.name },
    });
    return c.json(queue);
  });

  app.post("/queues/test", async (c) => {
    const body = await parse(c, queueBody);
    if ("response" in body) return body.response;
    return c.json(await testQueue(db, scopeOf(c), body.data as QueueDefinition, now()));
  });

  app.get("/queues/:id", async (c) =>
    c.json(await queueView(db, scopeOf(c), c.req.param("id"), c.get("userId"), now())),
  );

  app.put("/queues/:id", async (c) => {
    const body = await parse(c, queueBody);
    if ("response" in body) return body.response;
    const queue = await saveQueue(
      db,
      scopeOf(c),
      c.req.param("id"),
      body.data as QueueDefinition,
      c.get("userId"),
      now(),
    );
    await c.var.logActivity({
      action: "queue.updated",
      resource: { type: "queue", id: c.req.param("id") },
      details: { name: body.data.name },
    });
    return c.json(queue);
  });

  app.delete("/queues/:id", async (c) => {
    await deleteQueue(db, scopeOf(c), c.req.param("id"), c.get("userId"));
    await c.var.logActivity({ action: "queue.deleted", resource: { type: "queue", id: c.req.param("id") } });
    return c.json({ ok: true });
  });

  app.get("/queues/:id/cases", async (c) => {
    const queue = await findQueue(db, scopeOf(c), c.req.param("id"), c.get("userId"));
    const q = c.req.query();
    const result = await queueCases(db, scopeOf(c), queue, {
      ...(q.status && STATUSES.has(q.status)
        ? { status: q.status as CaseStatus | "unresolved" | "open_decisions" }
        : {}),
      ...(q.due === "overdue" ? { overdueAt: now() } : {}),
      ...(q.priority && PRIORITIES.has(q.priority) ? { priority: q.priority as CasePriority } : {}),
      ...(q.assignee ? { assignee: q.assignee === "me" ? (c.get("userId") ?? "none") : q.assignee } : {}),
      ...(q.q ? { q: q.q.slice(0, 200) } : {}),
      limit: bounded(q.limit, 50, 1, 200),
      offset: Math.max(Math.floor(Number(q.offset)) || 0, 0),
    });
    return c.json(result);
  });

  app.get("/cases/:id", async (c) => c.json(await caseDetail(db, scopeOf(c), c.req.param("id"), c.get("userId"))));

  app.get("/case-view-templates", (c) => c.json({ templates }));

  app.get("/cases/:id/view", async (c) =>
    c.json(await caseView(repos, scopeOf(c), c.req.param("id"), c.get("userId"), now())),
  );

  const draftOf = async (c: Context<Env>) => {
    const body = (await c.req.json().catch(() => null)) as { view?: unknown } | null;
    const problems = validateView(body?.view);
    if (problems.length) throw invalid(problems.join("; "));
    return body!.view as CaseView;
  };

  app.post("/cases/:id/view/preview", async (c) =>
    c.json(await caseView(repos, scopeOf(c), c.req.param("id"), c.get("userId"), now(), await draftOf(c))),
  );

  app.post("/cases/:id/view/preview/lists/:block", async (c) => {
    const draft = await draftOf(c);
    const query = {
      block: c.req.param("block"),
      entity: { type: c.req.query("type") ?? "", id: c.req.query("entity") ?? "" },
      list: c.req.query("list") ?? "",
      q: c.req.query("q")?.trim() || undefined,
      limit: bounded(c.req.query("limit"), 25, 1, 100),
      offset: bounded(c.req.query("offset"), 0, 0, 1_000_000),
    };
    return c.json(await caseViewList(repos, scopeOf(c), c.req.param("id"), query, c.get("userId"), now(), draft));
  });

  app.get("/cases/:id/view/lists/:block", async (c) => {
    const query = {
      block: c.req.param("block"),
      entity: { type: c.req.query("type") ?? "", id: c.req.query("entity") ?? "" },
      list: c.req.query("list") ?? "",
      q: c.req.query("q")?.trim() || undefined,
      limit: bounded(c.req.query("limit"), 25, 1, 100),
      offset: bounded(c.req.query("offset"), 0, 0, 1_000_000),
    };
    return c.json(await caseViewList(repos, scopeOf(c), c.req.param("id"), query, c.get("userId"), now()));
  });

  app.get("/cases/:id/view/media/:block/:index", async (c) => {
    const found = await caseMedia(
      db,
      scopeOf(c),
      c.req.param("id"),
      { block: c.req.param("block"), index: Number(c.req.param("index")) },
      c.get("userId"),
      now(),
      webhooks?.allowPrivate ?? false,
    );
    if (!found.ok) return error(c, MEDIA_ERROR[found.reason][0], MEDIA_ERROR[found.reason][1], found.problem);
    return c.body(new Uint8Array(found.body), 200, mediaHeaders(found.type));
  });

  app.post("/cases/:id/view/viewed", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { block?: unknown } | null;
    if (typeof body?.block !== "string") return error(c, 400, "invalid_request", "block: required");
    return c.json(
      await recordViewed(repos, scopeOf(c), c.req.param("id"), body.block, actorOf(c), c.get("userId"), now()),
    );
  });

  app.post("/cases/:id/checks", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      block?: unknown;
      point?: unknown;
      checked?: unknown;
    } | null;
    if (typeof body?.block !== "string" || !Number.isInteger(body.point) || typeof body.checked !== "boolean")
      return error(c, 400, "invalid_request", "body: { block, point, checked }");
    const input = { block: body.block, point: body.point as number, checked: body.checked };
    const done = await checkPoint(repos, scopeOf(c), c.req.param("id"), input, actorOf(c), c.get("userId"), now());
    await logCase(c, "checked", input);
    return c.json(done);
  });

  app.get("/cases/:id/timeline", async (c) =>
    c.json(
      await caseTimeline(repos, scopeOf(c), c.req.param("id"), c.get("userId"), c.req.query("items_only") === "true"),
    ),
  );

  app.post("/cases/:id/assign", async (c) => {
    const body = await parse(c, assignBody);
    if ("response" in body) return body.response;
    const done = sent(
      await assignCase(
        repos,
        scopeOf(c),
        c.req.param("id"),
        body.data.assignee,
        actorOf(c, body.data.by),
        c.get("userId"),
        now(),
      ),
    );
    await logCase(c, "assigned", { assignee: body.data.assignee });
    return c.json(done.case);
  });

  app.post("/cases/:id/take", async (c) => {
    const me = c.get("userId");
    if (!me) return error(c, 400, "invalid_request", "Only a signed-in person can take a case");
    const done = sent(await assignCase(repos, scopeOf(c), c.req.param("id"), me, actorOf(c), me, now()));
    await logCase(c, "assigned", { assignee: me });
    return c.json(done.case);
  });

  app.post("/cases/:id/reopen", async (c) => {
    // The console sends no body.
    const raw = await c.req.json().catch(() => ({}));
    const body = reopenBody.safeParse(raw ?? {});
    if (!body.success) return error(c, 400, "invalid_request", "by: who reopened it, at most 200 characters");
    const done = sent(
      await reopenCase(repos, scopeOf(c), c.req.param("id"), actorOf(c, body.data.by), c.get("userId"), now()),
    );
    await logCase(c, "reopened");
    return c.json(done.case);
  });

  app.post("/queues/:id/cases/bulk", async (c) => {
    const queue = await findQueue(db, scopeOf(c), c.req.param("id"), c.get("userId"));
    const body = await parse(c, bulkBody);
    if ("response" in body) return body.response;
    const { ids, ...action } = body.data;
    const done = sent(await bulkCases(repos, scopeOf(c), queue, ids, action, actorOf(c), c.get("userId"), now()));
    await c.var.logActivity({
      action: "case.bulk_updated",
      resource: { type: "queue", id: queue.id },
      details: { ...action, cases: ids },
    });
    return c.json({ results: done.results });
  });

  app.post("/cases/:id/notes", async (c) => {
    const body = await parse(c, noteBody);
    if ("response" in body) return body.response;
    const note = await addNote(
      repos,
      scopeOf(c),
      c.req.param("id"),
      body.data.text,
      actorOf(c, body.data.by),
      c.get("userId"),
      now(),
    );
    await logCase(c, "note_added");
    return c.json(note);
  });

  app.post("/cases/:id/resolve", async (c) => {
    const body = await parse(c, resolveBody);
    if ("response" in body) return body.response;
    const { by, ...input } = body.data;
    const done = sent(
      await resolveCase(repos, scopeOf(c), c.req.param("id"), input, actorOf(c, by), c.get("userId"), now()),
    );
    await logCase(c, "resolved", { category: input.category });
    return c.json({ ...done.case, decisions_resolved: done.decisions_resolved, labelled: done.labelled });
  });

  return app;
}
