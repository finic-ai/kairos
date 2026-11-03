import { Hono, type Context } from "hono";
import { checked, type Env } from "../../platform/http";
import type { Repositories } from "../../repositories";
import type { RulesetView } from "../../services/ruleset.service";
import { draftBody, evaluateBody, listQuery, testBody, updateBody, versionQuery } from "./schema";
import {
  discardDraft,
  evaluate,
  getRuleset,
  listRulesets,
  listVersions,
  publishRuleset,
  saveDraft,
  setArchived,
  testDefinition,
  updateRuleset,
} from "./service";
import type { RulesetTemplate } from "./types";

export type RulesetsDeps = Pick<Repositories, "db"> & { now: () => Date; templates: RulesetTemplate[] };

const scopeOf = (c: Context<Env>) => ({ workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
const byOf = (c: Context<Env>) => c.get("userId") ?? c.get("apiKey")?.id ?? null;
const json = (c: Context<Env>) => c.req.json().catch(() => undefined);

/** `:ruleset` is the slug, or the id. */
export function rulesetRoutes({ db, now, templates }: RulesetsDeps) {
  const app = new Hono<Env>();
  const log = (c: Context<Env>, verb: string, ruleset: RulesetView, details: Record<string, unknown> = {}) =>
    c.var.logActivity({
      action: `ruleset.${verb}`,
      resource: { type: "ruleset", id: ruleset.id },
      details: { slug: ruleset.slug, version: ruleset.version, ...details },
    });

  app.get("/ruleset-templates", (c) => c.json({ templates }));

  app.get("/rulesets", async (c) => {
    const { archived, ...query } = checked(listQuery, c.req.query());
    return c.json(await listRulesets(db, scopeOf(c), { archived: archived === "true", ...query }));
  });

  app.post("/rulesets/test", async (c) => {
    const { definition, input } = checked(testBody, await json(c));
    return c.json(await testDefinition(db, scopeOf(c), definition, input));
  });

  app.get("/rulesets/:ruleset", async (c) => {
    const { version } = checked(versionQuery, c.req.query());
    return c.json(await getRuleset(db, scopeOf(c), c.req.param("ruleset"), version));
  });

  app.get("/rulesets/:ruleset/versions", async (c) =>
    c.json(await listVersions(db, scopeOf(c), c.req.param("ruleset"))),
  );

  app.put("/rulesets/:ruleset/draft", async (c) => {
    const body = checked(draftBody, await json(c));
    const { ruleset, created } = await saveDraft(db, scopeOf(c), c.req.param("ruleset"), body, byOf(c), now());
    await log(c, created ? "created" : "draft_saved", ruleset);
    return c.json(ruleset, created ? 201 : 200);
  });

  app.delete("/rulesets/:ruleset/draft", async (c) => {
    const ruleset = await discardDraft(db, scopeOf(c), c.req.param("ruleset"), byOf(c), now());
    await log(c, "draft_discarded", ruleset);
    return c.json(ruleset);
  });

  app.post("/rulesets/:ruleset/publish", async (c) => {
    const ruleset = await publishRuleset(db, scopeOf(c), c.req.param("ruleset"), byOf(c), now());
    await log(c, "published", ruleset);
    return c.json(ruleset);
  });

  app.patch("/rulesets/:ruleset", async (c) => {
    const change = checked(updateBody, await json(c));
    const ruleset = await updateRuleset(db, scopeOf(c), c.req.param("ruleset"), change, byOf(c), now());
    await log(c, "updated", ruleset, { changes: Object.keys(change) });
    return c.json(ruleset);
  });

  for (const [path, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const)
    app.post(`/rulesets/:ruleset/${path}`, async (c) => {
      const ruleset = await setArchived(db, scopeOf(c), c.req.param("ruleset"), archived, byOf(c), now());
      await log(c, archived ? "archived" : "restored", ruleset);
      return c.json(ruleset);
    });

  app.post("/rulesets/:ruleset/evaluate", async (c) => {
    const { version } = checked(versionQuery, c.req.query());
    const { input } = checked(evaluateBody, await json(c));
    return c.json(await evaluate(db, scopeOf(c), c.req.param("ruleset"), version, input));
  });

  return app;
}
