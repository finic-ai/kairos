import type { Decider } from "@kairos/core";
import { Hono, type Context } from "hono";
import { checked, error, type Env } from "../../platform/http";
import { invalid } from "../../platform/error";
import type { Repositories } from "../../repositories";
import { WorkflowRunsService, WorkflowsService } from "../../services/workflow.service";
import {
  cancelRun,
  checkModels,
  discardDraft,
  exportTrainingData,
  newHookToken,
  newRunKey,
  publishWorkflow,
  receiveHook,
  runAndWait,
  saveDraft,
  saveWorkflow,
  setArchived,
  startRun,
  toRunView,
  updateWorkflow,
} from "./service";
import { checkInputs, validateWorkflow, waitProblem } from "./libs";
import { trainingDataBody } from "./schema";
import {
  MAX_WAIT_SECONDS,
  WAIT_SECONDS,
  type WorkflowDefinitionDef,
  type WorkflowInputDef,
  type WorkflowStepDef,
} from "./types";

export interface WorkflowsDeps {
  repos: Repositories;
  now: () => Date;
  /** For the runs that a caller waits for, which this process runs itself. */
  decider: Decider;
  allowPrivate: boolean;
  wake?: () => void;
}

/** A manual trigger's input, checked against its inputs, with their defaults. Throws with each problem. */
function manualInput(trigger: Record<string, unknown>, given: Record<string, unknown>) {
  if (trigger.type !== "manual") return given;
  const { values, problems } = checkInputs(trigger.inputs as WorkflowInputDef[] | undefined, given);
  if (problems.length) throw invalid(problems.join("; "));
  return values;
}

/** A workflow is data with a trigger and steps, saved and run in the background. See internal/designs/workflows.md. */
export function workflowRoutes({ repos, now, decider, allowPrivate, wake }: WorkflowsDeps) {
  const app = new Hono<Env>();
  const scopeOf = (c: Context<Env>) => ({ workspaceId: c.get("workspaceId"), environmentId: c.get("environmentId") });
  const workflowsOf = (c: Context<Env>) => new WorkflowsService(repos.db, scopeOf(c));
  const runsOf = (c: Context<Env>) => new WorkflowRunsService(repos.db, scopeOf(c));
  const logWorkflow = (
    c: Context<Env>,
    verb: string,
    workflow: { id: string; name: string; version: number },
    details: Record<string, unknown> = {},
  ) =>
    c.var.logActivity({
      action: `workflow.${verb}`,
      resource: { type: "workflow", id: workflow.id },
      details: { name: workflow.name, version: workflow.version, ...details },
    });
  /** Log the change when there was a workflow to change: null answers 404. */
  const logged = async <T extends { id: string; name: string; version: number }>(
    c: Context<Env>,
    verb: string,
    workflow: T | null,
  ) => {
    if (workflow) await logWorkflow(c, verb, workflow);
    return workflow;
  };

  app.put("/workflows/:name", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<WorkflowDefinitionDef> | null;
    if (!body || typeof body !== "object") throw invalid("body: must be a workflow definition");
    const existed = await workflowsOf(c).findByName(c.req.param("name"));
    const saved = await saveWorkflow(
      repos.db,
      scopeOf(c),
      { ...body, name: c.req.param("name") } as WorkflowDefinitionDef,
      c.get("userId") ?? null,
      now(),
    );
    await logWorkflow(c, existed ? "updated" : "created", saved);
    return c.json(saved);
  });

  app.get("/workflows", async (c) =>
    c.json({ workflows: await workflowsOf(c).listAll(c.req.query("archived") === "true") }),
  );

  const notFound = (c: Context<Env>) => error(c, 404, "not_found", `No workflow "${c.req.param("name")}"`);
  const body = async (c: Context<Env>) => {
    const parsed = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") throw invalid("body: must be a JSON object");
    return parsed;
  };

  /** Runs keep the live version until a publish. */
  app.put("/workflows/:name/draft", async (c) => {
    const draft = (await body(c)) as Partial<WorkflowDefinitionDef>;
    const saved = await saveDraft(
      repos.db,
      scopeOf(c),
      { ...draft, name: c.req.param("name") } as WorkflowDefinitionDef,
      now(),
    );
    await logWorkflow(c, "draft_saved", saved);
    return c.json(saved);
  });

  app.delete("/workflows/:name/draft", async (c) => {
    const workflow = await logged(
      c,
      "draft_discarded",
      await discardDraft(repos.db, scopeOf(c), c.req.param("name"), now()),
    );
    return workflow ? c.json(workflow) : notFound(c);
  });

  app.post("/workflows/:name/publish", async (c) => {
    const workflow = await logged(
      c,
      "published",
      await publishWorkflow(repos.db, scopeOf(c), c.req.param("name"), c.get("userId") ?? null, now()),
    );
    return workflow ? c.json(workflow) : notFound(c);
  });

  /** Pause or activate (`enabled`), or rename (`displayName`). Neither makes a version. */
  app.patch("/workflows/:name", async (c) => {
    const changes = await body(c);
    const workflow = await updateWorkflow(repos.db, scopeOf(c), c.req.param("name"), changes, now());
    if (!workflow) return notFound(c);
    await logWorkflow(c, "updated", workflow, { changes });
    return c.json(workflow);
  });

  /** Make the URL of the webhook trigger, or a new one: the old one stops. The token is shown only here. */
  app.post("/workflows/:name/hook", async (c) => {
    const made = await newHookToken(repos.db, scopeOf(c), c.req.param("name"), now());
    if (!made) return notFound(c);
    const workflow = await workflowsOf(c).findByName(c.req.param("name"));
    if (workflow) await logWorkflow(c, "hook_rotated", workflow, { hint: made.hint });
    return c.json({ path: `/v1/workflow-hooks/${made.token}`, hint: made.hint });
  });

  app.post("/workflows/:name/archive", async (c) => {
    const workflow = await logged(
      c,
      "archived",
      await setArchived(repos.db, scopeOf(c), c.req.param("name"), true, now()),
    );
    return workflow ? c.json(workflow) : notFound(c);
  });

  app.post("/workflows/:name/restore", async (c) => {
    const workflow = await logged(
      c,
      "restored",
      await setArchived(repos.db, scopeOf(c), c.req.param("name"), false, now()),
    );
    return workflow ? c.json(workflow) : notFound(c);
  });

  app.get("/workflows/:name", async (c) => {
    const asked = c.req.query("version");
    const version = asked === undefined ? undefined : Number(asked);
    if (version !== undefined && (!Number.isInteger(version) || version < 1))
      return error(c, 404, "not_found", `No version "${asked}" of workflow "${c.req.param("name")}"`);
    const workflow =
      version === undefined
        ? await workflowsOf(c).findByName(c.req.param("name"))
        : await workflowsOf(c).findVersion(c.req.param("name"), version);
    return workflow ? c.json(workflow) : notFound(c);
  });

  app.get("/workflows/:name/versions", async (c) => {
    const workflow = await workflowsOf(c).findByName(c.req.param("name"));
    if (!workflow) return notFound(c);
    return c.json({ versions: await workflowsOf(c).listVersions(c.req.param("name")) });
  });

  app.delete("/workflows/:name", async (c) => {
    // For good: its runs go with it. Archive keeps them. The versions stay in definition_versions.
    const gone = await workflowsOf(c).deleteMany({ name: c.req.param("name") });
    for (const workflow of gone) await logWorkflow(c, "deleted", workflow);
    return gone.length ? c.json({ deleted: true }) : notFound(c);
  });

  app.post("/workflows/:name/training-data", async (c) => {
    const body = checked(trainingDataBody, await c.req.json().catch(() => undefined));
    const { csv, counts } = await exportTrainingData(repos.db, scopeOf(c), c.req.param("name"), body, now());
    const workflow = await workflowsOf(c).findByName(c.req.param("name"));
    if (workflow) await logWorkflow(c, "training_data_exported", workflow, { counts });
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "X-Kairos-Rows": String(counts.rows),
      "X-Kairos-Positives": String(counts.positives),
      "X-Kairos-Already-Labeled": String(counts.already_labeled),
      "X-Kairos-Outcome-Unknown": String(counts.outcome_unknown),
      "X-Kairos-No-Subject": String(counts.no_subject),
    });
  });

  /**
   * Run an unsaved definition once, with no side effects except the steps named in `live_steps`.
   * `mock_outputs` gives, by step id, what a step that only shows itself outputs for the steps after it.
   */
  app.post("/workflows/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      definition?: WorkflowDefinitionDef;
      input?: Record<string, unknown>;
      live_steps?: string[];
      mock_outputs?: Record<string, unknown>;
    } | null;
    if (!body?.definition) throw invalid("definition: the workflow definition to test");
    const mocks = body.mock_outputs;
    if (mocks !== undefined && (typeof mocks !== "object" || mocks === null || Array.isArray(mocks)))
      throw invalid("mock_outputs: an object of sample outputs by step id");
    const problems = validateWorkflow(body.definition);
    if (problems.length) throw invalid(problems.join("; "));
    await checkModels(repos.db, scopeOf(c), body.definition.steps);
    const { displayName: _d, enabled: _e, ...definition } = body.definition;
    // A test of a saved workflow is one of its runs; a test of one never saved belongs to none.
    const saved = await workflowsOf(c).findByName(body.definition.name);
    const run = await startRun(
      repos,
      scopeOf(c),
      {
        workflowId: saved?.id ?? null,
        name: body.definition.name,
        version: 0,
        key: `test:${newRunKey()}`,
        trigger: {
          ...manualInput(body.definition.trigger, body.input ?? {}),
          live_steps: body.live_steps ?? [],
          mock_outputs: body.mock_outputs ?? {},
        },
        test: true,
        definition: definition as unknown as Record<string, unknown>,
      },
      now(),
    );
    await c.var.logActivity({
      action: "workflow_run.tested",
      resource: { type: "workflow_run", id: run.id },
      details: { workflow: body.definition.name, live_steps: body.live_steps ?? [] },
    });
    return c.json(toRunView(run), 202);
  });

  app.post("/workflows/:name/runs", async (c) => {
    const workflow = await workflowsOf(c).findByName(c.req.param("name"));
    if (!workflow) return notFound(c);
    if (workflow.status === "archived") throw invalid(`the workflow "${workflow.name}" is archived`);
    if (workflow.status === "draft") throw invalid(`the workflow "${workflow.name}" is not published yet`);
    if (!workflow.enabled) throw invalid(`the workflow "${workflow.name}" is paused`);
    if (workflow.trigger.type === "decision")
      throw invalid(
        `the workflow "${workflow.name}" makes the decisions of "${String(workflow.trigger.action)}": call POST /v1/decide`,
      );
    const body = (await c.req.json().catch(() => ({}))) as {
      input?: Record<string, unknown>;
      idempotency_key?: string;
      wait?: boolean;
      timeout_seconds?: number;
    } | null;
    if (
      body?.input !== undefined &&
      (typeof body.input !== "object" || body.input === null || Array.isArray(body.input))
    )
      throw invalid("input: an object");
    const args = {
      workflowId: workflow.id,
      name: workflow.name,
      version: workflow.version,
      key: body?.idempotency_key ? `manual:${body.idempotency_key}` : newRunKey(),
      trigger: manualInput(workflow.trigger, body?.input ?? {}),
    };
    const logRun = (run: { id: string }) =>
      c.var.logActivity({
        action: "workflow_run.started",
        resource: { type: "workflow_run", id: run.id },
        details: { workflow: workflow.name, version: workflow.version },
      });
    if (!body?.wait) {
      const run = await startRun(repos, scopeOf(c), args, now());
      await logRun(run);
      return c.json(toRunView(run), 202);
    }

    const problem = waitProblem(workflow.steps as unknown as WorkflowStepDef[]);
    if (problem) throw invalid(`wait: ${problem}`);
    const asked = body.timeout_seconds;
    if (asked !== undefined && !(typeof asked === "number" && asked >= 1 && asked <= MAX_WAIT_SECONDS))
      throw invalid(`timeout_seconds: from 1 to ${MAX_WAIT_SECONDS}`);
    const { run, answered } = await runAndWait(
      { repos, decider, now, allowPrivate, ...(wake ? { wake } : {}) },
      scopeOf(c),
      args,
      asked ?? WAIT_SECONDS,
      now(),
    );
    await logRun(run);
    const ended = ["done", "filtered", "failed", "cancelled"].includes(run.status);
    return c.json(toRunView(run), ended || answered ? 200 : 202);
  });

  app.get("/workflows/:name/runs", async (c) => {
    const workflow = await workflowsOf(c).findByName(c.req.param("name"));
    if (!workflow) return notFound(c);
    const limit = Math.min(500, Math.max(1, Math.floor(Number(c.req.query("limit"))) || 50));
    const runs = await runsOf(c).findMany({
      where: { workflowId: workflow.id },
      orderBy: { created: "desc" },
      limit,
    });
    return c.json({ runs: runs.map(toRunView) });
  });

  app.get("/workflow-runs/:id", async (c) => {
    const run = await runsOf(c).findById(c.req.param("id"));
    return run ? c.json(toRunView(run)) : error(c, 404, "not_found", `No run "${c.req.param("id")}"`);
  });

  app.post("/workflow-runs/:id/cancel", async (c) => {
    const run = await cancelRun(repos, scopeOf(c), c.req.param("id"), now());
    if (!run) return error(c, 404, "not_found", `No run "${c.req.param("id")}"`);
    await c.var.logActivity({
      action: "workflow_run.cancelled",
      resource: { type: "workflow_run", id: run.id },
      details: { workflow: run.workflow },
    });
    return c.json(toRunView(run));
  });

  return app;
}

/** A delivery is at most this big, as for inbound webhooks. */
const MAX_HOOK_BODY = 1024 * 1024;

/**
 * The URL of a webhook trigger: a provider cannot send a Kairos key, so the token in the URL
 * stands for one. Mount it before the key check, which it skips.
 */
export function workflowHookRoutes({ repos, now }: WorkflowsDeps) {
  const app = new Hono<Env>();
  app.on(["GET", "POST", "PUT"], "/workflow-hooks/:token", async (c) => {
    const declared = Number(c.req.header("content-length"));
    if (declared > MAX_HOOK_BODY) return error(c, 413, "too_large", "The body is larger than 1 MB");
    const body = c.req.method === "GET" ? "" : await c.req.text();
    if (Buffer.byteLength(body) > MAX_HOOK_BODY) return error(c, 413, "too_large", "The body is larger than 1 MB");
    const answer = await receiveHook(
      repos,
      c.req.param("token"),
      { method: c.req.method, headers: c.req.header(), query: c.req.query(), body },
      now(),
    );
    return c.json(answer.body, answer.status);
  });
  return app;
}
