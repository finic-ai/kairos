import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { CliError, entityRef, integer, json, object, pairs, parse, props, readText, timestamp } from "../args";
import { group, need, path, type Command, type Context } from "../context";
import { bold, dim, fields, green, list, more, outcome, printJson, show, table, when } from "../output";

const MAX_BATCH = 500;
const probability = (value: unknown) => (typeof value === "number" ? value.toFixed(3) : "-");

function entitiesOf(values: string[] | undefined, what: string): Record<string, string> {
  const entities = pairs(values, "Entity");
  if (Object.keys(entities).length === 0) throw new CliError(`${what} needs at least one entity: --entity user=u_42`);
  return entities;
}

export const track: Command = async (args, ctx) => {
  const { values, positionals } = parse(args, {
    entity: { type: "string", short: "e", multiple: true },
    prop: { type: "string", short: "p", multiple: true },
    data: { type: "string", short: "d" },
    file: { type: "string", short: "f" },
    session: { type: "string", short: "s" },
    ts: { type: "string" },
    id: { type: "string" },
    "universal-id": { type: "string" },
    status: { type: "string" },
  });
  if (values.file) return sendFile(values.file, ctx);
  const type = need(positionals[0], "track <event type> --entity user=u_42 [--prop amount=120]");
  const event = {
    id: values.id ?? `evt_${randomUUID()}`,
    type,
    ts: timestamp(values.ts),
    entities: entitiesOf(values.entity, "An event"),
    properties: { ...object(values.data), ...props(values.prop) },
    ...(values.session ? { session: values.session } : {}),
    ...(values["universal-id"] ? { universal_id: values["universal-id"] } : {}),
    ...(values.status ? { status: values.status } : {}),
  };
  const result = await ctx.client().request("POST", "/v1/events", { body: { batch: [event] } });
  show(ctx.json, { ...result, id: event.id }, () =>
    console.log(
      result.duplicates ? `${dim("Already stored:")} ${event.id}` : `${green("Stored")} ${type} ${dim(event.id)}`,
    ),
  );
};

/** A JSON array or JSON Lines of events in the form of the API. An event without an id gets one. */
async function sendFile(file: string, ctx: Context) {
  const text = readText(file);
  let events: Record<string, unknown>[];
  try {
    events =
      extname(file) === ".jsonl" || !text.trimStart().startsWith("[")
        ? text
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
        : JSON.parse(text);
  } catch {
    throw new CliError(`${file} is not a JSON array or JSON Lines`);
  }
  const client = ctx.client();
  let accepted = 0;
  let duplicates = 0;
  for (let i = 0; i < events.length; i += MAX_BATCH) {
    const batch = events.slice(i, i + MAX_BATCH).map((event) => ({ id: `evt_${randomUUID()}`, ...event }));
    try {
      const result = await client.request("POST", "/v1/events", { body: { batch } });
      accepted += result.accepted ?? 0;
      duplicates += result.duplicates ?? 0;
    } catch (cause) {
      throw new CliError(
        `Events ${i + 1} to ${i + batch.length}: ${(cause as Error).message}. ${accepted} were stored before.`,
      );
    }
    if (!ctx.json && process.stderr.isTTY)
      process.stderr.write(`\r${Math.min(i + MAX_BATCH, events.length)} / ${events.length}`);
  }
  if (!ctx.json && process.stderr.isTTY) process.stderr.write("\r");
  show(ctx.json, { accepted, duplicates }, () =>
    console.log(`${green("Stored")} ${accepted} events${duplicates ? `, ${duplicates} stored before` : ""}`),
  );
}

export const decide: Command = async (args, ctx) => {
  const { values, positionals } = parse(args, {
    entity: { type: "string", short: "e", multiple: true },
    prop: { type: "string", short: "p", multiple: true },
    data: { type: "string", short: "d" },
    session: { type: "string", short: "s" },
    ts: { type: "string" },
  });
  const action = need(positionals[0], "decide <action> --entity user=u_42 [--prop amount=900]");
  const body = {
    action,
    entities: entitiesOf(values.entity, "A decision"),
    properties: { ...object(values.data), ...props(values.prop) },
    ...(values.session ? { session: values.session } : {}),
    ...(values.ts ? { ts: timestamp(values.ts) } : {}),
  };
  const decision = await ctx.client().request("POST", "/v1/decide", { body });
  show(ctx.json, decision, () => {
    console.log(
      `${bold(outcome(decision.decision))}  ${dim("risk")} ${decision.risk_score}  ${dim("p")} ${probability(decision.probability)}`,
    );
    fields([
      ["action", decision.action],
      ["typology", decision.typology],
      ["reasons", list(decision.reasons)],
      ["rules", list(decision.rules)],
      ["decision", decision.decision_id],
      ...(decision.workflow_run_id ? ([["workflow run", decision.workflow_run_id]] as [string, unknown][]) : []),
    ]);
  });
};

const decisionRows = (ctx: Context, data: { decisions: any[]; total?: number }) =>
  show(ctx.json, data, () => {
    table(data.decisions, [
      ["ID", (d) => d.id],
      ["TIME", (d) => when(d.ts)],
      ["ACTION", (d) => d.action],
      ["SUBJECT", (d) => `${d.subject.type}:${d.subject.id}`],
      ["OUTCOME", (d) => outcome(d.decision?.decision)],
      ["FINAL", (d) => (d.final_outcome && d.final_outcome !== d.decision?.decision ? outcome(d.final_outcome) : "")],
      ["RISK", (d) => d.decision?.risk_score],
      ["SESSION", (d) => d.session],
    ]);
    more(data.total, data.decisions.length);
  });

export const decisions = group("decisions", {
  list: async (args, ctx) => {
    const { values } = parse(args, {
      outcome: { type: "string" },
      action: { type: "string" },
      subject: { type: "string" },
      session: { type: "string", short: "s" },
      before: { type: "string" },
      limit: { type: "string", short: "n" },
      offset: { type: "string" },
    });
    const subject = values.subject ? entityRef(values.subject) : undefined;
    const data = await ctx.client().request("GET", "/v1/decisions", {
      query: {
        outcome: values.outcome,
        action: values.action,
        subject_type: subject?.type,
        subject_id: subject?.id,
        session: values.session,
        before: values.before,
        limit: integer(values.limit, "--limit"),
        offset: integer(values.offset, "--offset"),
      },
    });
    decisionRows(ctx, data);
  },
  get: async (args, ctx) => {
    const { positionals } = parse(args, {});
    const id = need(positionals[0], "decisions get <decision id>");
    const d = await ctx.client().request("GET", `/v1/decisions/${path(id)}`);
    show(ctx.json, d, () => {
      console.log(
        `${bold(outcome(d.decision?.decision))}  ${dim("risk")} ${d.decision?.risk_score}  ${dim("p")} ${probability(d.decision?.probability)}`,
      );
      fields([
        ["id", d.id],
        ["time", when(d.ts)],
        ["action", d.action],
        ["subject", `${d.subject.type}:${d.subject.id}`],
        ["typology", d.decision?.typology],
        ["reasons", list(d.decision?.reasons)],
        ["session", d.session],
        ["event", d.event_id],
        ["automatic", d.automatic ? "yes" : undefined],
        ["final", d.final_outcome ? outcome(d.final_outcome) : undefined],
        [
          "resolution",
          d.resolution
            ? `${d.resolution.outcome} by ${d.resolution.by}${d.resolution.note ? `: ${d.resolution.note}` : ""}`
            : undefined,
        ],
      ]);
      console.log(dim("\nUse --json to see what the model was shown and what it answered."));
    });
  },
  resolve: async (args, ctx) => {
    const { values, positionals } = parse(args, {
      note: { type: "string" },
      by: { type: "string" },
    });
    const usage = "decisions resolve <decision id> <approve|block> [--note text]";
    const id = need(positionals[0], usage);
    const resolution = need(positionals[1], usage);
    if (resolution !== "approve" && resolution !== "block") throw new CliError(`Usage: kairos ${usage}`);
    const result = await ctx.client().request("POST", `/v1/decisions/${path(id)}/resolution`, {
      body: {
        outcome: resolution,
        ...(values.note ? { note: values.note } : {}),
        ...(values.by ? { by: values.by } : {}),
      },
    });
    show(ctx.json, result, () =>
      console.log(`${id} is now ${outcome(result.final_outcome)} ${dim(`(revision ${result.revision})`)}`),
    );
  },
});

export const label: Command = async (args, ctx) => {
  const { values, positionals } = parse(args, {
    prop: { type: "string", short: "p", multiple: true },
    ts: { type: "string" },
  });
  const usage = "label <type:id> <label> [--prop source=chargeback]";
  const entity = entityRef(need(positionals[0], usage));
  const name = need(positionals[1], usage);
  const item = {
    entity,
    label: name,
    properties: props(values.prop),
    ...(values.ts ? { ts: timestamp(values.ts) } : {}),
  };
  const result = await ctx.client().request("POST", "/v1/labels", { body: { batch: [item] } });
  show(ctx.json, result, () => console.log(`${green("Labelled")} ${entity.type}:${entity.id} ${bold(name)}`));
};

const typeRows = (ctx: Context, data: { types: any[] }) =>
  show(ctx.json, data, () =>
    table(
      data.types,
      [
        ["TYPE", (t) => t.type],
        ["ENTITIES", (t) => t.count],
        ["EVENTS", (t) => t.events],
        ["LABELLED", (t) => t.labelled],
        ["LAST SEEN", (t) => when(t.last_seen)],
        ["DEFINED", (t) => (t.definition ? "yes" : "")],
      ],
      "No entities yet.",
    ),
  );

export const entities = group("entities", {
  list: async (args, ctx) => {
    const { values } = parse(args, {
      type: { type: "string", short: "t" },
      q: { type: "string" },
      label: { type: "string" },
      outcome: { type: "string" },
      "risk-min": { type: "string" },
      active: { type: "string" },
      prop: { type: "string", multiple: true },
      sort: { type: "string" },
      limit: { type: "string", short: "n" },
      offset: { type: "string" },
    });
    const data = await ctx.client().request("GET", "/v1/entities", {
      query: {
        type: values.type,
        q: values.q,
        label: values.label,
        outcome: values.outcome,
        risk_min: values["risk-min"],
        active: values.active,
        prop: values.prop,
        sort: values.sort,
        limit: integer(values.limit, "--limit"),
        offset: integer(values.offset, "--offset"),
      },
    });
    if (!values.type) return typeRows(ctx, data);
    show(ctx.json, data, () => {
      table(data.entities, [
        ["ID", (e: any) => e.id],
        ["EVENTS", (e: any) => e.events],
        ["LAST SEEN", (e: any) => when(e.last_seen)],
        ["LABELS", (e: any) => list(e.labels)],
        [
          "DECISION",
          (e: any) => (e.decision ? `${outcome(e.decision.decision)} ${dim(String(e.decision.risk_score))}` : ""),
        ],
      ]);
      more(data.total, data.entities.length);
    });
  },
  get: async (args, ctx) => {
    const { values, positionals } = parse(args, { limit: { type: "string", short: "n" } });
    const usage = "entities get <type> <id>";
    const type = need(positionals[0], usage);
    const id = need(positionals[1], usage);
    const e = await ctx.client().request("GET", `/v1/entities/${path(type, id)}`, {
      query: { limit: integer(values.limit, "--limit") },
    });
    show(ctx.json, e, () => {
      console.log(`${bold(`${e.type}:${e.id}`)}  ${dim(`first seen ${when(e.first_seen)}`)}`);
      fields([
        ["labels", list(e.labels.map((l: { label: string }) => l.label))],
        ...Object.entries(e.properties ?? {}).map(
          ([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : v] as [string, unknown],
        ),
      ]);
      console.log(bold("\nRecent events"));
      table((e.events ?? []).slice(0, 15), [
        ["TIME", (ev: any) => when(ev.ts)],
        ["TYPE", (ev: any) => ev.type],
        ["STATUS", (ev: any) => ev.status],
        ["ID", (ev: any) => ev.id],
      ]);
      console.log(bold("\nDecisions"));
      table(e.decisions ?? [], [
        ["ID", (d: any) => d.id],
        ["TIME", (d: any) => when(d.ts)],
        ["ACTION", (d: any) => d.action],
        ["OUTCOME", (d: any) => outcome(d.decision?.decision)],
        ["RISK", (d: any) => d.decision?.risk_score],
      ]);
    });
  },
  set: async (args, ctx) => {
    const { values, positionals } = parse(args, {
      prop: { type: "string", short: "p", multiple: true },
      data: { type: "string", short: "d" },
      unset: { type: "string", multiple: true },
    });
    const usage = "entities set <type> <id> --prop kyc_country=GB [--unset trial_ends]";
    const type = need(positionals[0], usage);
    const id = need(positionals[1], usage);
    const body = { properties: { ...object(values.data), ...props(values.prop) }, unset: values.unset ?? [] };
    const result = await ctx.client().request("PUT", `/v1/entities/${path(type, id)}`, { body });
    show(ctx.json, result, () => console.log(`${green("Saved")} ${type}:${id}`));
  },
});

export const entityTypes = group("entity-types", {
  list: async (args, ctx) => {
    parse(args, {});
    typeRows(ctx, await ctx.client().request("GET", "/v1/entity-types"));
  },
  get: async (args, ctx) => {
    const { positionals } = parse(args, {});
    printJson(
      await ctx.client().request("GET", `/v1/entity-types/${path(need(positionals[0], "entity-types get <type>"))}`),
    );
  },
  shape: async (args, ctx) => {
    const { positionals } = parse(args, {});
    printJson(
      await ctx
        .client()
        .request("GET", `/v1/entity-types/${path(need(positionals[0], "entity-types shape <type>"))}/shape`),
    );
  },
  define: async (args, ctx) => {
    const { values, positionals } = parse(args, { data: { type: "string", short: "d" } });
    const type = need(positionals[0], "entity-types define <type> --data @definition.json");
    const result = await ctx.client().request("PUT", `/v1/entity-types/${path(type)}`, { body: object(values.data) });
    show(ctx.json, result, () => console.log(`${green("Defined")} ${type}`));
  },
});

type Trigger = string | { event: string; status?: string | string[] } | undefined;
const trigger = (value: Trigger) =>
  !value || typeof value === "string"
    ? (value ?? "")
    : `${value.event}${value.status ? `:${[value.status].flat().join("|")}` : ""}`;

export const actions = group("actions", {
  list: async (args, ctx) => {
    parse(args, {});
    const data = await ctx.client().request("GET", "/v1/actions");
    show(ctx.json, data, () =>
      table(
        data.actions,
        [
          ["NAME", (a: any) => a.name],
          ["VERSION", (a: any) => a.version],
          ["SUBJECT", (a: any) => a.subject],
          ["TRIGGER", (a: any) => trigger(a.trigger)],
          ["AUTOMATIC", (a: any) => (a.automatic ? "yes" : "")],
          ["QUESTION", (a: any) => (a.hold?.length > 70 ? `${a.hold.slice(0, 69)}…` : a.hold)],
        ],
        'No actions. Define one with "kairos actions define <name> --data @action.json".',
      ),
    );
  },
  get: async (args, ctx) => {
    const { positionals } = parse(args, {});
    printJson(await ctx.client().request("GET", `/v1/actions/${path(need(positionals[0], "actions get <name>"))}`));
  },
  define: async (args, ctx) => {
    const { values, positionals } = parse(args, { data: { type: "string", short: "d" } });
    const name = need(positionals[0], "actions define <name> --data @action.json");
    if (!values.data) throw new CliError("Give the definition: --data @action.json, or --data '{…}'");
    const result = await ctx.client().request("PUT", `/v1/actions/${path(name)}`, { body: object(values.data) });
    show(ctx.json, result, () => console.log(`${green("Defined")} ${name} ${dim(`version ${result.version}`)}`));
  },
  templates: async (args, ctx) => {
    parse(args, {});
    const data = await ctx.client().request("GET", "/v1/templates");
    show(ctx.json, data, () =>
      table(data.templates, [
        ["NAME", (t: any) => t.name],
        ["SUBJECT", (t: any) => t.subject],
        ["TRIGGER", (t: any) => trigger(t.trigger)],
        ["DESCRIPTION", (t: any) => t.description ?? t.displayName],
      ]),
    );
  },
});

export const sessions = group("sessions", {
  list: async (args, ctx) => {
    const { values } = parse(args, {
      q: { type: "string" },
      outcome: { type: "string" },
      limit: { type: "string", short: "n" },
      offset: { type: "string" },
    });
    const data = await ctx.client().request("GET", "/v1/sessions", {
      query: {
        q: values.q,
        outcome: values.outcome,
        limit: integer(values.limit, "--limit"),
        offset: integer(values.offset, "--offset"),
      },
    });
    show(ctx.json, data, () => {
      table(data.sessions, [
        ["ID", (s: any) => s.id],
        ["LAST SEEN", (s: any) => when(s.last_seen)],
        ["EVENTS", (s: any) => s.events],
        ["DECISIONS", (s: any) => s.decisions],
        ["OUTCOME", (s: any) => (s.outcome ? `${outcome(s.outcome)} ${dim(String(s.risk_score))}` : "")],
        [
          "ENTITIES",
          (s: any) =>
            Object.entries(s.entities ?? {})
              .map(([t, ids]) => `${t}:${(ids as string[]).join(",")}`)
              .join(" "),
        ],
      ]);
      more(data.total, data.sessions.length);
    });
  },
  get: async (args, ctx) => {
    const { values, positionals } = parse(args, { limit: { type: "string", short: "n" } });
    const id = need(positionals[0], "sessions get <session id>");
    const s = await ctx
      .client()
      .request("GET", `/v1/sessions/${path(id)}`, { query: { limit: integer(values.limit, "--limit") } });
    show(ctx.json, s, () => {
      console.log(`${bold(s.id)}  ${dim(`${when(s.started)} → ${when(s.last_seen)}`)}`);
      table(s.events ?? [], [
        ["TIME", (ev: any) => when(ev.ts)],
        ["TYPE", (ev: any) => ev.type],
        [
          "ENTITIES",
          (ev: any) =>
            Object.entries(ev.entities ?? {})
              .map(([t, v]) => `${t}:${v}`)
              .join(" "),
        ],
      ]);
      if (s.decisions?.length) {
        console.log(bold("\nDecisions"));
        decisionRows({ ...ctx, json: false }, { decisions: s.decisions });
      }
    });
  },
});

export const stats: Command = async (args, ctx) => {
  parse(args, {});
  const data = await ctx.client().request("GET", "/v1/stats");
  show(ctx.json, data, () =>
    fields([
      ["events", data.events],
      ["decisions", data.decisions],
      ["actions", data.actions],
      ...Object.entries(data.outcomes ?? {}).map(([key, value]) => [`  ${outcome(key)}`, value] as [string, unknown]),
    ]),
  );
};

export const usageReport: Command = async (args, ctx) => {
  const { values } = parse(args, { days: { type: "string" } });
  const data = await ctx.client().request("GET", "/v1/usage", { query: { days: integer(values.days, "--days") } });
  show(ctx.json, data, () => {
    table(data.days ?? [], [
      ["DAY", (d: any) => d.day],
      ["EVENTS", (d: any) => d.events],
      ["DECISIONS", (d: any) => d.decisions],
      ["INPUT TOKENS", (d: any) => d.input_tokens],
    ]);
    if (data.stored)
      console.log(
        dim(
          `\nStored: ${data.stored.events} events, ${data.stored.decisions} decisions, ${data.stored.entities} entities`,
        ),
      );
  });
};

export const api: Command = async (args, ctx) => {
  const { values, positionals } = parse(args, {
    data: { type: "string", short: "d" },
    query: { type: "string", short: "q", multiple: true },
  });
  const usage = "api <METHOD> <path> [--data '{…}' | --data @file.json] [--query name=value]";
  const method = need(positionals[0], usage).toUpperCase();
  let target = need(positionals[1], usage);
  if (!target.startsWith("/")) target = `/${target}`;
  if (/^\/app\/workspaces\/-(\/|$)/.test(target))
    target = target.replace("/app/workspaces/-", ctx.client().workspacePath());
  printJson(
    await ctx.client().request(method, target, { body: json(values.data), query: pairs(values.query, "Query") }),
  );
};
