import { CliError, integer, parse } from "../args";
import { group, need, path, type Context } from "../context";
import { bold, dim, green, printJson, red, show, state, table, when, yellow, type Column } from "../output";

const workspace = (ctx: Context) => {
  const client = ctx.client();
  return { client, base: client.workspacePath() };
};

const signedIn = (ctx: Context) => {
  const client = ctx.client();
  if (!client.hasSession) throw new CliError(`Sign in with your email address first: "kairos login --email".`);
  return client;
};

export const workspaces = group("workspaces", {
  list: async (args, ctx) => {
    parse(args, {});
    const me = await signedIn(ctx).request("GET", "/auth/me");
    const current = ctx.stored().workspace?.id;
    show(ctx.json, me.workspaces, () =>
      table(me.workspaces, [
        ["", (w: any) => (w.id === current ? green("*") : "")],
        ["NAME", (w: any) => w.name],
        ["ROLE", (w: any) => w.role],
        ["ENVIRONMENTS", (w: any) => (w.environments ?? []).map((e: any) => e.name).join(", ")],
        ["ID", (w: any) => w.id],
      ]),
    );
  },
  create: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const name = need(positionals.join(" ").trim(), "workspaces create <name>");
    const created = await signedIn(ctx).request("POST", "/app/workspaces", { body: { name } });
    show(ctx.json, created, () =>
      console.log(
        `${green("Created")} ${bold(created.name)} ${dim(created.id)}\nUse it: kairos use --workspace ${created.id}`,
      ),
    );
  },
});

export const environments = group("environments", {
  list: async (args, ctx) => {
    parse(args, {});
    const { client, base } = workspace(ctx);
    const data = await client.request("GET", `${base}/environments`);
    const current = ctx.stored().environment?.id;
    show(ctx.json, data, () =>
      table(data.environments, [
        ["", (e: any) => ((current ? e.id === current : e.kind === "production") ? green("*") : "")],
        ["NAME", (e: any) => e.name],
        ["KIND", (e: any) => e.kind],
        ["CREATED", (e: any) => when(e.created)],
        ["ID", (e: any) => e.id],
      ]),
    );
  },
});

export const jobs = group("jobs", {
  list: async (args, ctx) => {
    const { values } = parse(args, {
      status: { type: "string" },
      kind: { type: "string" },
      limit: { type: "string", short: "n" },
      offset: { type: "string" },
    });
    const { client, base } = workspace(ctx);
    const data = await client.request("GET", `${base}/jobs`, {
      query: {
        status: values.status,
        kind: values.kind,
        limit: integer(values.limit, "--limit"),
        offset: integer(values.offset, "--offset"),
      },
    });
    show(ctx.json, data, () =>
      table(data.jobs, [
        ["ID", (j: any) => j.id],
        ["KIND", (j: any) => j.kind],
        ["STATUS", (j: any) => state(j.status)],
        ["ATTEMPTS", (j: any) => j.attempts],
        ["NEXT RUN", (j: any) => (j.status === "pending" ? when(j.run_at) : "")],
        ["FINISHED", (j: any) => when(j.finished)],
        ["LAST ERROR", (j: any) => j.last_error],
      ]),
    );
  },
  summary: async (args, ctx) => {
    parse(args, {});
    const { client, base } = workspace(ctx);
    const data = await client.request("GET", `${base}/jobs/summary`);
    show(ctx.json, data, () =>
      table(
        data.kinds,
        [
          ["KIND", (k: any) => k.kind],
          ["PENDING", (k: any) => k.pending],
          ["PAUSED", (k: any) => k.paused],
          ["DONE", (k: any) => k.done],
          ["DEAD", (k: any) => (k.dead ? red(String(k.dead)) : k.dead)],
        ],
        "No jobs.",
      ),
    );
  },
  get: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "jobs get <job id>");
    const { client, base } = workspace(ctx);
    printJson(await client.request("GET", `${base}/jobs/${path(id)}`));
  },
  retry: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "jobs retry <job id>");
    const { client, base } = workspace(ctx);
    const job = await client.request("POST", `${base}/jobs/${path(id)}/retry`);
    show(ctx.json, job, () => console.log(`${green("Queued")} ${id} again`));
  },
});

export const keys = group("keys", {
  list: async (args, ctx) => {
    const { values } = parse(args, { all: { type: "boolean", short: "a" } });
    const { client, base } = workspace(ctx);
    const data = await client.request("GET", `${base}/keys`);
    const rows = values.all ? data.keys : data.keys.filter((k: any) => !k.revoked);
    show(ctx.json, { keys: rows }, () =>
      table(
        rows,
        [
          ["ID", (k: any) => k.id],
          ["NAME", (k: any) => k.name],
          ["KIND", (k: any) => k.kind],
          ["KEY", (k: any) => k.hint],
          ["LAST USED", (k: any) => when(k.last_used)],
          ["CREATED", (k: any) => when(k.created)],
          ...(values.all ? [["REVOKED", (k: any) => when(k.revoked)] as Column<any>] : []),
        ],
        'No keys. Make one with "kairos keys create <name>".',
      ),
    );
  },
  create: async (args, ctx) => {
    const { values, positionals } = parse(args, {
      kind: { type: "string" },
      "allow-ip": { type: "string", multiple: true },
      "allow-origin": { type: "string", multiple: true },
    });
    const name = need(
      positionals.join(" ").trim(),
      "keys create <name> [--kind secret|public] [--allow-ip 203.0.113.0/24]",
    );
    const kind = values.kind ?? "secret";
    if (kind !== "secret" && kind !== "public") throw new CliError("--kind is secret or public");
    const { client, base } = workspace(ctx);
    const result = await client.request("POST", `${base}/keys`, {
      body: { name, kind, allowed_ips: values["allow-ip"] ?? [], allowed_origins: values["allow-origin"] ?? [] },
    });
    show(ctx.json, result, () => {
      console.log(`${green("Created")} ${kind} key ${bold(name)} ${dim(result.key.id)}\n`);
      console.log(`  ${result.secret}\n`);
      console.log(yellow("This is the only time the key is shown. Keep it now."));
    });
  },
  revoke: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "keys revoke <key id>");
    const { client, base } = workspace(ctx);
    const result = await client.request("DELETE", `${base}/keys/${path(id)}`);
    show(ctx.json, result, () => console.log(`Revoked ${id}. It stops working at once.`));
  },
});
