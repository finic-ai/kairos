import { Hono, type Context } from "hono";
import { checked, error, type Env } from "../../platform/http";
import { invalid } from "../../platform/error";
import type { Repositories } from "../../repositories";
import { readUpload } from "./libs";
import { listQuery, promoteBody, renameBody, scoreBody, uploadBody } from "./schema";
import {
  archiveModel,
  getModel,
  getVersion,
  listModels,
  promoteVersion,
  readModelFile,
  renameModel,
  scoreFeatures,
  uploadVersion,
} from "./service";

export type ModelsDeps = Pick<Repositories, "db"> & { now: () => Date };

const scopeOf = (c: Context<Env>) => ({ workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });

const versionOf = (c: Context<Env>) => {
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version) || version < 1) throw invalid(`version: "${c.req.param("version")}" is not a version`);
  return version;
};

const json = (c: Context<Env>) => c.req.json().catch(() => undefined);

export function modelRoutes({ db, now }: ModelsDeps) {
  const app = new Hono<Env>();

  app.get("/models", async (c) => {
    return c.json(await listModels(db, scopeOf(c), checked(listQuery, c.req.query())));
  });

  app.get("/models/:slug", async (c) => c.json(await getModel(db, scopeOf(c), c.req.param("slug"))));

  app.post("/models/:slug/versions", async (c) => {
    const upload = await readUpload(c.req.raw);
    if ("status" in upload)
      return error(c, upload.status, upload.status === 413 ? "too_large" : "invalid_request", upload.message);
    const body = checked(uploadBody, upload.json);
    const result = await uploadVersion(db, scopeOf(c), c.req.param("slug"), body, now(), c.get("userId") ?? null);
    if (result.created)
      await c.var.logActivity({
        action: "model.version_uploaded",
        resource: { type: "model", id: c.req.param("slug") },
        details: { version: result.version },
      });
    return c.json(result, result.created ? 201 : 200);
  });

  app.get("/models/:slug/versions/:version", async (c) =>
    c.json(await getVersion(db, scopeOf(c), c.req.param("slug"), versionOf(c))),
  );

  app.get("/models/:slug/versions/:version/file", async (c) => {
    const slug = c.req.param("slug");
    const version = versionOf(c);
    const file = await readModelFile(db, scopeOf(c), slug, version);
    return c.body(new Uint8Array(file), 200, {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${slug}-${version}.json"`,
    });
  });

  app.post("/models/:slug/versions/:version/score", async (c) => {
    const { features } = checked(scoreBody, await json(c));
    const ref = `${c.req.param("slug")}@${versionOf(c)}`;
    return c.json(await scoreFeatures(db, scopeOf(c), ref, features, { strict: true }));
  });

  app.post("/models/:slug/versions/:version/promote", async (c) => {
    const userId = c.get("userId");
    if (!userId)
      return error(
        c,
        403,
        "forbidden",
        "An API key is for one environment: promote a model from the console, or with kairos login",
      );
    const { to } = checked(promoteBody, await json(c));
    const result = await promoteVersion(db, scopeOf(c), c.req.param("slug"), versionOf(c), to, now(), userId);
    await c.var.logActivity({
      action: "model.version_promoted",
      resource: { type: "model", id: c.req.param("slug") },
      details: { version: versionOf(c), to: result.environment, reference: result.reference },
    });
    return c.json(result, result.created ? 201 : 200);
  });

  app.patch("/models/:slug", async (c) => {
    const { name } = checked(renameBody, await json(c));
    const model = await renameModel(db, scopeOf(c), c.req.param("slug"), name, now());
    await c.var.logActivity({
      action: "model.renamed",
      resource: { type: "model", id: c.req.param("slug") },
      details: { name },
    });
    return c.json(model);
  });

  app.post("/models/:slug/archive", async (c) => {
    const model = await archiveModel(db, scopeOf(c), c.req.param("slug"), now());
    await c.var.logActivity({ action: "model.archived", resource: { type: "model", id: c.req.param("slug") } });
    return c.json(model);
  });

  return app;
}
