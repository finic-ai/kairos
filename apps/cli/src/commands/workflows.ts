import { CliError, integer, object, parse, props } from "../args";
import { group, need, path, type Context } from "../context";
import { bold, dim, fields, green, printJson, red, show, state, table, when } from "../output";

interface Run {
  id: string;
  workflow: string;
  status: string;
  steps: { path?: string; id: string; name?: string; status: string; attempt?: number; error?: string }[];
  output: unknown;
  error: string | null;
  created: string;
  started: string | null;
  finished: string | null;
}

function showRun(ctx: Context, run: Run): void {
  show(ctx.json, run, () => {
    console.log(`${bold(state(run.status))}  ${run.workflow}  ${dim(run.id)}`);
    fields([
      ["created", when(run.created)],
      ["started", when(run.started)],
      ["finished", when(run.finished)],
      ["error", run.error ? red(run.error) : undefined],
    ]);
    if (run.steps.length) {
      console.log(bold("\nSteps"));
      table(run.steps, [
        ["STEP", (s) => s.path ?? s.id],
        ["NAME", (s) => s.name],
        ["STATUS", (s) => state(s.status)],
        ["ATTEMPT", (s) => s.attempt],
        ["ERROR", (s) => s.error],
      ]);
    }
    if (run.output !== null && run.output !== undefined) {
      console.log(bold("\nOutput"));
      printJson(run.output);
    }
  });
}

const trigger = (t: { type?: string; event?: string; action?: string; schedule?: string } | undefined) =>
  !t ? "" : `${t.type}${t.event ? `:${t.event}` : t.action ? `:${t.action}` : t.schedule ? ` ${t.schedule}` : ""}`;

export const workflows = group("workflows", {
  list: async (args, ctx) => {
    const { values } = parse(args, { archived: { type: "boolean" } });
    const data = await ctx.client().request("GET", "/v1/workflows", { query: { archived: values.archived } });
    show(ctx.json, data, () =>
      table(
        data.workflows,
        [
          ["NAME", (w: any) => w.name],
          ["VERSION", (w: any) => w.version],
          ["STATUS", (w: any) => state(w.status)],
          ["ENABLED", (w: any) => (w.enabled ? "yes" : dim("paused"))],
          ["TRIGGER", (w: any) => trigger(w.trigger)],
          ["STEPS", (w: any) => w.steps?.length],
          ["DRAFT", (w: any) => (w.draft ? "yes" : "")],
          ["FAILING SINCE", (w: any) => (w.failing_since ? red(when(w.failing_since)) : "")],
        ],
        'No workflows. Define one with "kairos workflows define <name> --data @workflow.json".',
      ),
    );
  },
  get: async (args, ctx) => {
    const { values, positionals } = parse(args, { version: { type: "string" } });
    const name = need(positionals[0], "workflows get <name> [--version N]");
    printJson(
      await ctx.client().request("GET", `/v1/workflows/${path(name)}`, {
        query: { version: integer(values.version, "--version") },
      }),
    );
  },
  define: async (args, ctx) => {
    const { values, positionals } = parse(args, { data: { type: "string", short: "d" }, draft: { type: "boolean" } });
    const name = need(positionals[0], "workflows define <name> --data @workflow.json [--draft]");
    if (!values.data) throw new CliError("Give the definition: --data @workflow.json, or --data '{…}'");
    const target = `/v1/workflows/${path(name)}${values.draft ? "/draft" : ""}`;
    const saved = await ctx.client().request("PUT", target, { body: object(values.data) });
    show(ctx.json, saved, () =>
      console.log(
        values.draft
          ? `${green("Saved")} the draft of ${name}. Publish it with "kairos workflows publish ${name}".`
          : `${green("Published")} ${name} ${dim(`version ${saved.version}`)}`,
      ),
    );
  },
  publish: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const name = need(positionals[0], "workflows publish <name>");
    const saved = await ctx.client().request("POST", `/v1/workflows/${path(name)}/publish`);
    show(ctx.json, saved, () => console.log(`${green("Published")} ${name} ${dim(`version ${saved.version}`)}`));
  },
  pause: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const name = need(positionals[0], "workflows pause <name>");
    const saved = await ctx.client().request("PATCH", `/v1/workflows/${path(name)}`, { body: { enabled: false } });
    show(ctx.json, saved, () => console.log(`Paused ${name}. No new runs start.`));
  },
  activate: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const name = need(positionals[0], "workflows activate <name>");
    const saved = await ctx.client().request("PATCH", `/v1/workflows/${path(name)}`, { body: { enabled: true } });
    show(ctx.json, saved, () => console.log(`${green("Activated")} ${name}`));
  },
  run: async (args, ctx) => {
    const { values, positionals } = parse(args, {
      input: { type: "string", short: "i", multiple: true },
      data: { type: "string", short: "d" },
      wait: { type: "boolean", short: "w" },
      timeout: { type: "string" },
      key: { type: "string" },
    });
    const name = need(positionals[0], "workflows run <name> [-i user=u_42] [--wait]");
    const body = {
      input: { ...object(values.data), ...props(values.input) },
      ...(values.key ? { idempotency_key: values.key } : {}),
      ...(values.wait ? { wait: true } : {}),
      ...(values.timeout ? { timeout_seconds: integer(values.timeout, "--timeout") } : {}),
    };
    showRun(ctx, await ctx.client().request("POST", `/v1/workflows/${path(name)}/runs`, { body }));
  },
  runs: async (args, ctx) => {
    const { values, positionals } = parse(args, { limit: { type: "string", short: "n" } });
    const name = need(positionals[0], "workflows runs <name>");
    const data = await ctx.client().request("GET", `/v1/workflows/${path(name)}/runs`, {
      query: { limit: integer(values.limit, "--limit") },
    });
    show(ctx.json, data, () =>
      table(data.runs as Run[], [
        ["ID", (r) => r.id],
        ["STATUS", (r) => state(r.status)],
        ["VERSION", (r) => r.workflow],
        ["CREATED", (r) => when(r.created)],
        ["FINISHED", (r) => when(r.finished)],
        ["ERROR", (r) => r.error],
      ]),
    );
  },
  status: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "workflows status <run id>");
    showRun(ctx, await ctx.client().request("GET", `/v1/workflow-runs/${path(id)}`));
  },
  cancel: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "workflows cancel <run id>");
    showRun(ctx, await ctx.client().request("POST", `/v1/workflow-runs/${path(id)}/cancel`));
  },
});
