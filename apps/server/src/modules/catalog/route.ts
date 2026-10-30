import { validateEntity, type EntityDefinition } from "@kairos/core";
import { Hono, type Context } from "hono";
import type { Webhooks } from "../../context";
import { bounded, error, parse, type Env } from "../../platform/http";
import type { Repositories } from "../../repositories";
import { DecisionsService } from "../../services/decision.service";
import { EntitiesService } from "../../services/entities.service";
import { LabelsService } from "../../services/label.service";
import { ObjectsService } from "../../services/object.service";
import { name } from "../../platform/fields";
import { entityBody, labelsBody, objectsBody } from "../ingest/schema";
import { addLabel, entityFacts, entityList, upsertObject } from "./service";
import { eraseEntity } from "./repo";
import { atLeast } from "../tenancy/repo";
import { MEDIA_ERROR, mediaHeaders, readMedia } from "../cases/libs";
import { WorkspacesService } from "../../services/workspace.service";
import type { PropertyCondition } from "../../types";

const OPS = ["eq", "ne", "contains", "gt", "lt", "exists", "missing"] as const;
const SORTS = ["active", "events", "risk", "first_seen"] as const;

export type CatalogDeps = Pick<Repositories, "db" | "entities" | "events" | "transaction"> & {
  now: () => Date;
  webhooks?: Webhooks;
  templates?: EntityDefinition[];
};

export function entityRoutes({ db, entities, events, transaction, now, webhooks, templates = [] }: CatalogDeps) {
  const app = new Hono<Env>();
  const scopeOf = (c: Context<Env>) => ({ workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
  const entityTypesOf = (c: Context<Env>) => new EntitiesService(db, scopeOf(c));

  app.put("/objects", async (c) => {
    const body = await parse(c, objectsBody);
    if ("response" in body) return body.response;
    const stamp = now().toISOString();
    for (const o of body.data.batch)
      await upsertObject(
        db,
        c.get("workspaceId"),
        c.get("environmentId"),
        { type: o.type, id: o.id },
        o.properties,
        stamp,
      );
    await c.var.logActivity({
      action: "entity.batch_updated",
      resource: { type: "entity" },
      details: { count: body.data.batch.length },
    });
    return c.json({ accepted: body.data.batch.length });
  });

  app.get("/objects/:type/:id", async (c) => {
    const entity = { type: c.req.param("type"), id: c.req.param("id") };
    const [object, labels] = await Promise.all([
      new ObjectsService(db, scopeOf(c)).findByEntity(entity),
      new LabelsService(db, scopeOf(c)).listFor(entity),
    ]);
    if (!object && labels.length === 0) return error(c, 404, "not_found", `No ${entity.type} "${entity.id}"`);
    return c.json({ ...entity, properties: object?.properties ?? {}, first_seen: object?.first_seen ?? null, labels });
  });

  app.post("/labels", async (c) => {
    const body = await parse(c, labelsBody);
    if ("response" in body) return body.response;
    const at = now();
    let queued = 0;
    for (const l of body.data.batch) {
      queued += await addLabel(
        { transaction },
        c.get("workspaceId"),
        c.get("environmentId"),
        l.entity,
        { label: l.label, ts: l.ts ? new Date(l.ts).toISOString() : at.toISOString(), properties: l.properties },
        at,
        Boolean(webhooks),
      );
    }
    if (queued > 0) webhooks?.worker?.wake();
    await c.var.logActivity({
      action: "label.added",
      resource: { type: "label" },
      details: { count: body.data.batch.length, labels: [...new Set(body.data.batch.map((l) => l.label))] },
    });
    return c.json({ accepted: body.data.batch.length });
  });

  app.put("/entity-types/:type", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<EntityDefinition> | null;
    if (!body || typeof body !== "object")
      return error(c, 400, "invalid_request", "body: must be an entity definition");
    const definition = { ...body, type: c.req.param("type") } as EntityDefinition;
    const problems = validateEntity(definition);
    if (problems.length) return error(c, 400, "invalid_request", problems.join("; "));
    const existed = await entityTypesOf(c).findByType(definition.type);
    const saved = await entityTypesOf(c).save(definition, now());
    await c.var.logActivity({
      action: existed ? "entity_type.updated" : "entity_type.created",
      resource: { type: "entity_type", id: definition.type },
    });
    return c.json(saved);
  });

  app.get("/entity-templates", (c) => c.json({ templates }));

  app.get("/entity-types", async (c) =>
    c.json({ types: await entities.entityTypes(c.get("workspaceId"), c.get("environmentId")) }),
  );

  app.get("/entity-types/:type/shape", async (c) =>
    c.json(await entities.entityShape(c.get("workspaceId"), c.get("environmentId"), c.req.param("type"))),
  );

  app.get("/entity-types/:type", async (c) => {
    const definition = await entityTypesOf(c).findByType(c.req.param("type"));
    return definition
      ? c.json(definition)
      : error(c, 404, "not_found", `Entity type "${c.req.param("type")}" is not defined`);
  });

  app.put("/entities/:type/:id", async (c) => {
    const body = await parse(c, entityBody);
    if ("response" in body) return body.response;
    const type = c.req.param("type");
    if (!name.safeParse(type).success) return error(c, 400, "invalid_request", 'type: must be a name such as "user"');
    const saved = await upsertObject(
      db,
      c.get("workspaceId"),
      c.get("environmentId"),
      { type, id: c.req.param("id") },
      body.data.properties,
      now().toISOString(),
      body.data.unset,
    );
    await c.var.logActivity({
      action: "entity.updated",
      resource: { type: "entity", id: `${type}:${c.req.param("id")}` },
      details: { set: Object.keys(body.data.properties ?? {}), unset: body.data.unset ?? [] },
    });
    return c.json(saved);
  });

  // Erasure of a person's data, for a privacy request: what Kairos holds about one entity.
  app.delete("/entities/:type/:id", async (c) => {
    if (c.get("userId") && !atLeast(c.get("role"), "admin"))
      return error(c, 403, "forbidden", "Erasing data needs the admin role, or a secret key");
    const type = c.req.param("type");
    const id = c.req.param("id");
    const dryRun = c.req.query("dry_run") === "true";
    const erased = await eraseEntity(db, scopeOf(c), { type, id }, { dryRun });
    if (!erased) return error(c, 404, "not_found", `Kairos holds nothing about ${type} "${id}"`);
    return c.json({ entity: { type, id }, dry_run: dryRun, erased });
  });

  app.get("/entities", async (c) => {
    const q = c.req.query();
    const types = await entities.entityTypes(c.get("workspaceId"), c.get("environmentId"));
    const type = q.type;
    if (!type) return c.json({ types, type: null, entities: [], next_offset: null });
    const limit = bounded(q.limit, 50, 1, 200);
    const offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);
    const conditions: PropertyCondition[] = [];
    for (const raw of c.req.queries("prop") ?? []) {
      const [property, op, ...rest] = raw.split(":");
      if (!property || !OPS.includes(op as (typeof OPS)[number]))
        return error(
          c,
          400,
          "invalid_request",
          `prop: "${raw}" must be name:op:value, where op is one of ${OPS.join(", ")}`,
        );
      conditions.push({ name: property, op: op as PropertyCondition["op"], value: rest.join(":") });
    }
    const active = /^(\d+)([hd])$/.exec(q.active ?? "");
    const filter = {
      type,
      q: q.q || undefined,
      labelled: q.labelled === "1",
      label: q.label || undefined,
      outcome: q.outcome || undefined,
      risk_min:
        q.risk_min !== undefined && q.risk_min !== "" && Number.isFinite(Number(q.risk_min))
          ? Number(q.risk_min)
          : undefined,
      active_since: active
        ? new Date(now().getTime() - Number(active[1]) * (active[2] === "h" ? 3_600_000 : 86_400_000)).toISOString()
        : undefined,
      properties: conditions,
      sort: SORTS.includes(q.sort as (typeof SORTS)[number]) ? (q.sort as (typeof SORTS)[number]) : undefined,
    };
    const [found, total] = await Promise.all([
      entities.listEntities(c.get("workspaceId"), c.get("environmentId"), { ...filter, limit, offset }),
      entities.countEntities(c.get("workspaceId"), c.get("environmentId"), filter),
    ]);
    return c.json({ types, type, entities: found, total, next_offset: found.length === limit ? offset + limit : null });
  });

  app.get("/entities/:type/:id", async (c) => {
    const workspaceId = c.get("workspaceId");
    const environmentId = c.get("environmentId");
    const entity = { type: c.req.param("type"), id: c.req.param("id") };
    const [object, labels, timeline, decided, sessions] = await Promise.all([
      new ObjectsService(db, scopeOf(c)).findByEntity(entity),
      new LabelsService(db, scopeOf(c)).listFor(entity),
      events.timeline(
        workspaceId,
        environmentId,
        entity,
        bounded(c.req.query("limit"), 100, 1, 500),
        now().toISOString(),
      ),
      new DecisionsService(db, scopeOf(c)).listSummaries({ limit: 20, subject: entity }),
      events.sessionsOf(workspaceId, environmentId, entity, 20),
    ]);
    if (!object && labels.length === 0 && timeline.length === 0)
      return error(c, 404, "not_found", `No ${entity.type} "${entity.id}"`);
    return c.json({
      ...entity,
      properties: object?.properties ?? {},
      first_seen: timeline[0]?.ts ?? object?.first_seen ?? null,
      labels,
      events: timeline.reverse(),
      decisions: decided,
      sessions,
    });
  });

  app.get("/entities/:type/:id/media/:property", async (c) => {
    const entity = { type: c.req.param("type"), id: c.req.param("id") };
    const property = c.req.param("property");
    const [object, definition, hosts] = await Promise.all([
      new ObjectsService(db, scopeOf(c)).findByEntity(entity),
      entityTypesOf(c).findByType(entity.type),
      new WorkspacesService(db).mediaHosts(c.get("workspaceId")),
    ]);
    const format = definition?.display?.formats?.[property];
    const found = await readMedia(object?.properties[property], hosts, {
      image: format === "image",
      allowPrivate: webhooks?.allowPrivate ?? false,
    });
    if (!found.ok) return error(c, MEDIA_ERROR[found.reason][0], MEDIA_ERROR[found.reason][1], found.problem);
    return c.body(new Uint8Array(found.body), 200, mediaHeaders(found.type));
  });

  app.get("/entities/:type/:id/facts", async (c) => {
    const entity = { type: c.req.param("type"), id: c.req.param("id") };
    const definition = await entityTypesOf(c).findByType(entity.type);
    return c.json({
      facts: await entityFacts({ db, entities }, scopeOf(c), entity, definition?.facts ?? [], c.get("userId"), now()),
    });
  });

  app.get("/entities/:type/:id/lists/:name", async (c) => {
    const entity = { type: c.req.param("type"), id: c.req.param("id") };
    const list = (await entityTypesOf(c).findByType(entity.type))?.lists?.find((l) => l.name === c.req.param("name"));
    if (!list) return error(c, 404, "not_found", `The ${entity.type} type has no list "${c.req.param("name")}"`);
    const page = {
      q: c.req.query("q")?.trim() || undefined,
      limit: bounded(c.req.query("limit"), 25, 1, 100),
      offset: bounded(c.req.query("offset"), 0, 0, 1_000_000),
    };
    return c.json(await entityList({ db, entities }, scopeOf(c), entity, list, page, c.get("userId"), now()));
  });

  return app;
}
