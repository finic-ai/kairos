import { Hono, type Context } from "hono";
import { checked, type Env } from "../../platform/http";
import { toExperimentView } from "../../services/workflow_experiment.service";
import { applyBody, experimentBody } from "./schema";
import { applyExperiment, createExperiment, getExperiment, listExperiments } from "./service";
import type { ExperimentsDeps } from "./types";

const scopeOf = (c: Context<Env>) => ({ workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
const json = (c: Context<Env>) => c.req.json().catch(() => undefined);

export function experimentRoutes({ db, now, wake }: ExperimentsDeps) {
  const app = new Hono<Env>();

  app.post("/workflows/:name/experiments", async (c) => {
    const body = checked(experimentBody, await json(c));
    const made = await createExperiment(
      db,
      scopeOf(c),
      c.req.param("name"),
      body,
      c.get("userId") ?? body.by ?? null,
      now(),
    );
    wake?.();
    return c.json(made, 202);
  });

  app.get("/experiments", async (c) => c.json({ experiments: await listExperiments(db, scopeOf(c)) }));

  app.get("/workflows/:name/experiments", async (c) =>
    c.json({ experiments: await listExperiments(db, scopeOf(c), c.req.param("name")) }),
  );

  app.get("/workflow-experiments/:id", async (c) =>
    c.json(toExperimentView(await getExperiment(db, scopeOf(c), c.req.param("id")))),
  );

  app.post("/workflow-experiments/:id/apply", async (c) => {
    const { by, ...choice } = checked(applyBody, await json(c));
    return c.json(
      await applyExperiment(db, scopeOf(c), c.req.param("id"), choice, c.get("userId") ?? by ?? null, now()),
    );
  });

  return app;
}
