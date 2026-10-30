import { CASE_CATEGORIES } from "@kairos/core";
import { CliError, integer, parse } from "../args";
import type { Client } from "../client";
import { group, need, path, type Context } from "../context";
import { bold, dim, fields, green, more, outcome, printJson, red, show, table, when, yellow } from "../output";

interface Case {
  id: string;
  queue_id: string;
  status: string;
  priority: string;
  assignee: { id: string; email: string; name: string } | null;
  target: { type: string; id: string };
  target_name?: string | null;
  reason: string;
  outcome: string | null;
  risk: number | null;
  evidence_count: number;
  resolution: { category: string; note?: string; by?: string } | null;
  due_at: string | null;
  created: string;
  last_activity: string;
}

const caseStatus = (value: string) =>
  value === "resolved" ? green(value) : value === "in_review" ? yellow(value) : value;
const priority = (value: string) => (value === "urgent" ? red(value) : value === "high" ? yellow(value) : value);
const target = (c: Case) =>
  c.target_name ? `${c.target_name} ${dim(`${c.target.type}:${c.target.id}`)}` : `${c.target.type}:${c.target.id}`;
const due = (c: Case) =>
  !c.due_at ? "" : c.status !== "resolved" && Date.parse(c.due_at) < Date.now() ? red(when(c.due_at)) : when(c.due_at);

async function queueId(client: Client, value: string): Promise<string> {
  const { queues } = await client.request<{ queues: { id: string; name: string }[] }>("GET", "/v1/queues");
  const found = queues.find((q) => q.id === value || q.name.toLowerCase() === value.toLowerCase());
  if (!found) throw new CliError(`No queue "${value}". There is: ${queues.map((q) => q.name).join(", ") || "none"}`);
  return found.id;
}

/** Members are listed under `/app`, so an email address needs a session; with an API key, give the user id. */
async function memberId(client: Client, email: string): Promise<string> {
  const { members } = await client.request<{ members: { id: string; email: string }[] }>(
    "GET",
    `${client.workspacePath()}/members`,
  );
  const found = members.find((m) => m.email.toLowerCase() === email.toLowerCase());
  if (!found) throw new CliError(`No member with the email address ${email} in this workspace.`);
  return found.id;
}

export const queues = group("queues", {
  list: async (args, ctx) => {
    parse(args, {});
    const data = await ctx.client().request("GET", "/v1/queues");
    show(ctx.json, data, () =>
      table(
        data.queues,
        [
          ["NAME", (q: any) => q.name],
          ["OPEN", (q: any) => q.counts?.open],
          ["IN REVIEW", (q: any) => q.counts?.in_review],
          ["UNASSIGNED", (q: any) => q.counts?.unassigned],
          ["OVERDUE", (q: any) => (q.counts?.overdue ? red(String(q.counts.overdue)) : q.counts?.overdue)],
          ["MINE", (q: any) => q.counts?.mine],
          ["ENABLED", (q: any) => (q.enabled === false ? dim("no") : "yes")],
          ["ID", (q: any) => q.id],
        ],
        "No queues. Make one in the console, under Queues.",
      ),
    );
  },
  get: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const client = ctx.client();
    const id = await queueId(client, need(positionals.join(" "), "queues get <queue name or id>"));
    printJson(await client.request("GET", `/v1/queues/${path(id)}`));
  },
});

function showCase(ctx: Context, c: Case & { queue?: { name: string }; evidence?: any[]; activity?: any[] }) {
  show(ctx.json, c, () => {
    console.log(`${bold(target(c))}  ${caseStatus(c.status)}  ${priority(c.priority)}  ${dim(c.id)}`);
    fields([
      ["queue", c.queue?.name ?? c.queue_id],
      ["reason", c.reason],
      ["outcome", c.outcome ? outcome(c.outcome) : undefined],
      ["risk", c.risk],
      ["assignee", c.assignee?.email ?? dim("nobody")],
      ["due", due(c)],
      ["opened", when(c.created)],
      [
        "resolution",
        c.resolution ? `${c.resolution.category}${c.resolution.note ? `: ${c.resolution.note}` : ""}` : undefined,
      ],
    ]);
    if (c.evidence?.length) {
      console.log(bold("\nEvidence"));
      table(c.evidence, [
        ["TIME", (e) => when(e.ts)],
        ["RULE", (e) => e.rule?.name],
        ["SOURCE", (e) => `${e.source.type} ${e.source.id}`],
        ["OUTCOME", (e) => outcome(e.snapshot?.decision?.outcome)],
        ["RISK", (e) => e.snapshot?.decision?.risk_score],
      ]);
    }
    if (c.activity?.length) {
      console.log(bold("\nActivity"));
      table(c.activity, [
        ["TIME", (a) => when(a.created)],
        ["WHAT", (a) => a.type],
        ["BY", (a) => a.actor],
        ["NOTE", (a) => a.payload?.text ?? a.payload?.note],
      ]);
    }
  });
}

export const cases = group("cases", {
  list: async (args, ctx) => {
    const { values, positionals } = parse(args, {
      status: { type: "string" },
      priority: { type: "string" },
      assignee: { type: "string" },
      overdue: { type: "boolean" },
      q: { type: "string" },
      limit: { type: "string", short: "n" },
      offset: { type: "string" },
    });
    const client = ctx.client();
    const id = await queueId(client, need(positionals.join(" "), "cases list <queue name or id> [--status open]"));
    const data = await client.request("GET", `/v1/queues/${path(id)}/cases`, {
      query: {
        status: values.status,
        priority: values.priority,
        assignee: values.assignee,
        due: values.overdue ? "overdue" : undefined,
        q: values.q,
        limit: integer(values.limit, "--limit"),
        offset: integer(values.offset, "--offset"),
      },
    });
    show(ctx.json, data, () => {
      table(data.cases as Case[], [
        ["ID", (c) => c.id],
        ["TARGET", target],
        ["STATUS", (c) => caseStatus(c.status)],
        ["PRIORITY", (c) => priority(c.priority)],
        ["ASSIGNEE", (c) => c.assignee?.email],
        ["OUTCOME", (c) => (c.outcome ? outcome(c.outcome) : undefined)],
        ["RISK", (c) => c.risk],
        ["DUE", due],
        ["OPENED", (c) => when(c.created)],
      ]);
      more(data.total, data.cases.length);
    });
  },
  get: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "cases get <case id>");
    showCase(ctx, await ctx.client().request("GET", `/v1/cases/${path(id)}`));
  },
  assign: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const usage = "cases assign <case id> <email | user id | none>";
    const id = need(positionals[0], usage);
    const who = need(positionals[1], usage);
    const client = ctx.client();
    const body = { assignee: who === "none" ? null : who.includes("@") ? await memberId(client, who) : who };
    showCase(ctx, await client.request("POST", `/v1/cases/${path(id)}/assign`, { body }));
  },
  take: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "cases take <case id>");
    showCase(ctx, await ctx.client().request("POST", `/v1/cases/${path(id)}/take`));
  },
  note: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const usage = 'cases note <case id> "text"';
    const id = need(positionals[0], usage);
    const text = need(positionals.slice(1).join(" "), usage);
    const result = await ctx.client().request("POST", `/v1/cases/${path(id)}/notes`, { body: { text } });
    show(ctx.json, result, () => console.log(`${green("Added")} a note to ${id}`));
  },
  resolve: async (args, ctx) => {
    const { values, positionals } = parse(args, {
      note: { type: "string" },
      "apply-to-decisions": { type: "boolean" },
      label: { type: "boolean" },
    });
    const usage = `cases resolve <case id> <${CASE_CATEGORIES.join("|")}> [--note text] [--apply-to-decisions] [--label]`;
    const id = need(positionals[0], usage);
    const category = need(positionals[1], usage);
    if (!(CASE_CATEGORIES as readonly string[]).includes(category)) throw new CliError(`Usage: kairos ${usage}`);
    const body = {
      category,
      ...(values.note ? { note: values.note } : {}),
      ...(values["apply-to-decisions"] ? { apply_to_decisions: true } : {}),
      ...(values.label ? { label_target: true } : {}),
    };
    showCase(ctx, await ctx.client().request("POST", `/v1/cases/${path(id)}/resolve`, { body }));
  },
  reopen: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "cases reopen <case id>");
    showCase(ctx, await ctx.client().request("POST", `/v1/cases/${path(id)}/reopen`));
  },
});
