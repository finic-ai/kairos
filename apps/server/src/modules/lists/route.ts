import { Hono, type Context } from "hono";
import { checked, type Env } from "../../platform/http";
import type { Repositories } from "../../repositories";
import type { ListView } from "../../services/list.service";
import { itemsBody, listQuery, putBody, removeBody, replaceBody } from "./schema";
import { addItems, deleteList, getList, listLists, listReaders, putList, removeItems, replaceItems } from "./service";

export type ListsDeps = Pick<Repositories, "db"> & { now: () => Date };

const scopeOf = (c: Context<Env>) => ({ workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
const byOf = (c: Context<Env>) => c.get("userId") ?? c.get("apiKey")?.id ?? null;
const json = (c: Context<Env>) => c.req.json().catch(() => undefined);

/** `:list` is the slug, or the id. A list is live data: no change makes a version. */
export function listRoutes({ db, now }: ListsDeps) {
  const app = new Hono<Env>();
  const log = (c: Context<Env>, verb: string, list: ListView, details: Record<string, unknown> = {}) =>
    c.var.logActivity({
      action: `list.${verb}`,
      resource: { type: "list", id: list.id },
      details: { slug: list.slug, ...details },
    });

  app.get("/lists", async (c) => c.json(await listLists(db, scopeOf(c), checked(listQuery, c.req.query()))));

  app.get("/lists/:list", async (c) => c.json(await getList(db, scopeOf(c), c.req.param("list"))));

  app.get("/lists/:list/readers", async (c) => c.json(await listReaders(db, scopeOf(c), c.req.param("list"))));

  app.put("/lists/:list", async (c) => {
    const body = checked(putBody, await json(c));
    const { list, created } = await putList(db, scopeOf(c), c.req.param("list"), body, byOf(c), now());
    await log(c, created ? "created" : "updated", list);
    return c.json(list, created ? 201 : 200);
  });

  app.post("/lists/:list/items", async (c) => {
    const { items } = checked(itemsBody, await json(c));
    const result = await addItems(db, scopeOf(c), c.req.param("list"), items, byOf(c), now());
    await log(c, "items_added", result.list, { count: result.added });
    return c.json(result);
  });

  app.delete("/lists/:list/items", async (c) => {
    const { values } = checked(removeBody, await json(c));
    const result = await removeItems(db, scopeOf(c), c.req.param("list"), values, byOf(c), now());
    await log(c, "items_removed", result.list, { count: result.removed });
    return c.json(result);
  });

  app.put("/lists/:list/items", async (c) => {
    const { items } = checked(replaceBody, await json(c));
    const result = await replaceItems(db, scopeOf(c), c.req.param("list"), items, byOf(c), now());
    await log(c, "items_replaced", result.list, { count: result.list.item_count });
    return c.json(result);
  });

  app.delete("/lists/:list", async (c) => {
    const list = await deleteList(db, scopeOf(c), c.req.param("list"));
    await log(c, "deleted", list);
    return c.json(list);
  });

  return app;
}
