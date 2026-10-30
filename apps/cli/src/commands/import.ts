import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, statSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  checkEntityMapping,
  checkEventMapping,
  checkLabelMapping,
  csvReader,
  entityFromRow,
  eventFromRow,
  IMPORT_BATCH,
  isJsonLines,
  jsonLine,
  labelFromRow,
  suggestIdColumn,
  type ImportRow,
} from "@kairos/core";
import { CliError, integer, pairs, parse } from "../args";
import { ApiError, type Client } from "../client";
import type { Command, Context } from "../context";
import { dim, green, printJson, yellow } from "../output";

/** A wrong command: exit code 2, the same as the Python importer. */
const usage = (message: string) => new CliError(message, 2);

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const columns = (value: string | undefined) =>
  value
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
const count = (n: number) => n.toLocaleString("en-US");

const COMMON = {
  format: { type: "string" },
  delimiter: { type: "string" },
  "dry-run": { type: "boolean" },
  limit: { type: "string" },
  rejects: { type: "string" },
  include: { type: "string" },
  exclude: { type: "string" },
  text: { type: "string" },
  strings: { type: "boolean" },
  "batch-size": { type: "string" },
} as const;

type Common = { [K in keyof typeof COMMON]?: (typeof COMMON)[K]["type"] extends "boolean" ? boolean : string };

const properties = (values: Common) => ({
  include: columns(values.include),
  exclude: columns(values.exclude) ?? [],
  text: columns(values.text) ?? [],
  typed: !values.strings,
});

/** The rows of a CSV or JSON-lines file, one part of the file at a time. */
async function* readRows(file: string, format: "csv" | "jsonl", delimiter: string): AsyncGenerator<ImportRow> {
  const stream = createReadStream(file, { encoding: "utf8" });
  if (format === "jsonl") {
    let line = 0;
    for await (const raw of createInterface({ input: stream, crlfDelay: Infinity })) {
      line++;
      const row = jsonLine(line === 1 ? raw.replace(/^\uFEFF/, "") : raw, line);
      if (row) yield row;
    }
    return;
  }
  const reader = csvReader(delimiter);
  for await (const chunk of stream) yield* reader.push(chunk as string);
  yield* reader.end();
}

type Converted = { ok: true; item: unknown } | { ok: false; reason: string };

interface Outcome {
  read: number;
  stored: number;
  duplicates: number;
  rejected: number;
  seconds: number;
  dry_run: boolean;
  rejects?: string;
  sample: unknown[];
}

/** Stops the import: the server cannot be reached, or refuses the request and not a row of it. */
class Stop extends CliError {}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(client: Client, method: string, path: string, batch: unknown[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.request<{ accepted?: number; duplicates?: number }>(method, path, { body: { batch } });
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : undefined;
      // A row the server refuses is named by its place in the batch, as in "batch.3.ts: …".
      if (status === 400 && (cause as ApiError).message.startsWith("batch.")) throw cause;
      if ((status === undefined || RETRYABLE.has(status)) && attempt < 5) {
        await sleep(Math.min(500 * 2 ** attempt, 8000));
        continue;
      }
      throw new Stop((cause as Error).message);
    }
  }
}

/** A batch the server refuses is sent again in halves, so that one bad row costs only itself. */
async function run(
  ctx: Context,
  file: string,
  values: Common,
  target: { method: string; path: string },
  convert: (row: ImportRow) => Converted,
): Promise<void> {
  if (!existsSync(file) || !statSync(file).isFile()) throw usage(`No file at ${file}`);
  const format = values.format ?? (isJsonLines(file) ? "jsonl" : "csv");
  if (format !== "csv" && format !== "jsonl") throw usage(`--format is csv or jsonl, not "${format}"`);
  const delimiter = values.delimiter === "\\t" || values.delimiter === "tab" ? "\t" : (values.delimiter ?? ",");
  if (delimiter.length !== 1) throw usage("--delimiter is one character, or \\t for a tab");
  const limit = integer(values.limit, "--limit");
  const batchSize = integer(values["batch-size"], "--batch-size") ?? IMPORT_BATCH;
  if (batchSize < 1 || batchSize > IMPORT_BATCH) throw usage(`--batch-size is 1 to ${IMPORT_BATCH}`);
  const dryRun = !!values["dry-run"];
  const client = dryRun ? undefined : ctx.client();
  if (client && !client.conn.apiKey && !client.conn.session)
    throw usage(`Sign in first: "kairos login", or set KAIROS_API_KEY. A dry run (--dry-run) needs no key.`);

  const rejectsPath = values.rejects ?? `${file}.rejects.jsonl`;
  let rejectsFile: number | undefined;
  const outcome: Outcome = { read: 0, stored: 0, duplicates: 0, rejected: 0, seconds: 0, dry_run: dryRun, sample: [] };
  const reject = (line: number, reason: string, row: Record<string, unknown>) => {
    outcome.rejected++;
    // Opened on the first rejected row, so that an import with none leaves no file.
    rejectsFile ??= openSync(rejectsPath, "w");
    writeSync(rejectsFile, JSON.stringify({ line, reason, row }) + "\n");
  };

  const started = performance.now();
  const showProgress = !dryRun && !ctx.json && process.stderr.isTTY;
  let shown = 0;
  const progress = (force = false) => {
    outcome.seconds = (performance.now() - started) / 1000;
    if (!showProgress || (!force && performance.now() - shown < 2000)) return;
    shown = performance.now();
    const rate = outcome.seconds > 0 ? outcome.read / outcome.seconds : 0;
    process.stderr.write(
      `\r  ${count(outcome.read)} read · ${count(outcome.stored)} stored · ${count(outcome.duplicates)} already there · ${count(outcome.rejected)} rejected · ${count(Math.round(rate))} rows/s`,
    );
  };

  const send = async (items: { row: ImportRow; item: unknown }[]): Promise<void> => {
    if (!items.length || !client) return;
    try {
      const answer = await post(
        client,
        target.method,
        target.path,
        items.map((i) => i.item),
      );
      outcome.stored += answer.accepted ?? items.length;
      outcome.duplicates += answer.duplicates ?? 0;
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status !== 400) throw cause;
      if (items.length === 1)
        return reject(items[0]!.row.line, `the server refused it: ${cause.message}`, items[0]!.row.values);
      const middle = Math.floor(items.length / 2);
      await send(items.slice(0, middle));
      await send(items.slice(middle));
    }
  };

  let batch: { row: ImportRow; item: unknown }[] = [];
  try {
    for await (const row of readRows(file, format, delimiter)) {
      if (limit !== undefined && outcome.read >= limit) break;
      outcome.read++;
      const converted = convert(row);
      if (!converted.ok) {
        reject(row.line, converted.reason, row.values);
        continue;
      }
      if (outcome.sample.length < 5) outcome.sample.push(converted.item);
      if (dryRun) continue;
      batch.push({ row, item: converted.item });
      if (batch.length >= batchSize) {
        await send(batch);
        batch = [];
        progress();
      }
    }
    await send(batch);
  } catch (cause) {
    if (showProgress) process.stderr.write("\n");
    if (!(cause instanceof Stop)) throw cause;
    throw new CliError(
      `${cause.message}\n${count(outcome.stored)} rows were stored before it stopped, and nothing that was stored is lost. Correct the problem and run the same command again: rows already stored are not stored twice.`,
    );
  } finally {
    if (rejectsFile !== undefined) closeSync(rejectsFile);
  }
  progress(true);
  if (showProgress) process.stderr.write("\n");
  if (outcome.rejected) outcome.rejects = rejectsPath;
  report(ctx, outcome);
}

function report(ctx: Context, outcome: Outcome): void {
  if (ctx.json) return printJson(outcome);
  const { read, stored, duplicates, rejected, seconds } = outcome;
  if (outcome.dry_run) {
    console.log(
      `Dry run: ${count(read)} rows read, ${count(read - rejected)} would be sent, ${count(rejected)} rejected. Nothing was sent.`,
    );
    if (outcome.sample.length) {
      console.log(dim("\nThe first rows, as they would be sent:"));
      for (const item of outcome.sample) console.log(`  ${JSON.stringify(item)}`);
    }
  } else {
    const already = duplicates ? `, ${count(duplicates)} were there already` : "";
    const rate = seconds > 0 ? Math.round(read / seconds) : 0;
    console.log(
      `${count(read)} rows read: ${green(`${count(stored)} stored`)}${already}, ${count(rejected)} rejected. ${seconds.toFixed(1)} s, ${count(rate)} rows a second.`,
    );
  }
  if (rejected) console.log(yellow(`The rejected rows are in ${outcome.rejects}, each with the reason.`));
}

function fileOf(positionals: string[], what: string): string {
  const [file, ...rest] = positionals;
  if (!file || rest.length)
    throw usage(`Usage: kairos import ${what} <file.csv | file.jsonl> …  See "kairos import --help".`);
  return file;
}

const events: Command = async (args, ctx) => {
  const { values, positionals } = parse(args, {
    ...COMMON,
    type: { type: "string" },
    "type-column": { type: "string" },
    ts: { type: "string" },
    "ts-format": { type: "string" },
    id: { type: "string" },
    entity: { type: "string", multiple: true },
    "no-auto-entities": { type: "boolean" },
    "universal-id": { type: "string" },
    status: { type: "string" },
    session: { type: "string" },
  });
  const file = fileOf(positionals, "events");
  const mapping = {
    type: values.type,
    typeColumn: values["type-column"],
    ts: values.ts,
    tsFormat: values["ts-format"],
    id: values.id,
    entities: pairs(values.entity, "--entity"),
    autoEntities: !values["no-auto-entities"],
    universalId: values["universal-id"],
    status: values.status,
    session: values.session,
    ...properties(values),
  };
  const problem = checkEventMapping(mapping);
  if (problem) throw usage(problem);
  await run(ctx, file, values, { method: "POST", path: "/v1/events" }, (row) => {
    const result = eventFromRow(row, mapping, sha256);
    return result.ok ? { ok: true, item: result.event } : result;
  });
};

const entities: Command = async (args, ctx) => {
  const { values, positionals } = parse(args, {
    ...COMMON,
    type: { type: "string" },
    id: { type: "string" },
  });
  const file = fileOf(positionals, "entities");
  if (!values.type) throw usage("Give the entity type of every row: --type user");
  const mapping = { type: values.type, id: values.id ?? "", ...properties(values) };
  const problem = checkEntityMapping(mapping);
  if (problem) throw usage(problem);
  await run(ctx, file, values, { method: "PUT", path: "/v1/objects" }, (row) => {
    // Without --id, the column the console would suggest, from the columns of the first row.
    if (!mapping.id) {
      mapping.id = suggestIdColumn(Object.keys(row.values), mapping.type) ?? "id";
      console.error(dim(`The id is in the column "${mapping.id}". Give --id to choose another.`));
    }
    const result = entityFromRow(row, mapping);
    return result.ok ? { ok: true, item: result.entity } : result;
  });
};

const labels: Command = async (args, ctx) => {
  const { values, positionals } = parse(args, {
    ...COMMON,
    entity: { type: "string" },
    label: { type: "string" },
    "label-column": { type: "string" },
    ts: { type: "string" },
    "ts-format": { type: "string" },
  });
  const file = fileOf(positionals, "labels");
  const [entity] = Object.entries(pairs(values.entity ? [values.entity] : [], "--entity"));
  if (!entity) throw usage("Say which entity each label is on: --entity user=customer_id");
  const mapping = {
    entityType: entity[0],
    entity: entity[1],
    label: values.label,
    labelColumn: values["label-column"],
    ts: values.ts,
    tsFormat: values["ts-format"],
    ...properties(values),
  };
  const problem = checkLabelMapping(mapping);
  if (problem) throw usage(problem);
  await run(ctx, file, values, { method: "POST", path: "/v1/labels" }, (row) => {
    const result = labelFromRow(row, mapping);
    return result.ok ? { ok: true, item: result.label } : result;
  });
};

export const IMPORT_HELP = `kairos import: load history from a CSV or JSON-lines file. Nothing is stored twice, so an import can be run again.

  kairos import events   <file> (--type TYPE | --type-column COLUMN) --ts COLUMN [--id COLUMN] [--entity TYPE=COLUMN …]
                         [--ts-format iso|unix|unix_ms|"%d/%m/%Y %H:%M"] [--universal-id COLUMN] [--status COLUMN]
                         [--session COLUMN] [--no-auto-entities]
  kairos import entities <file> --type TYPE [--id COLUMN]
  kairos import labels   <file> --entity TYPE=COLUMN (--label LABEL | --label-column COLUMN) [--ts COLUMN] [--ts-format …]

For all three:
  --dry-run            Read and check every row, show the first ones, and send nothing
  --limit N            Stop after N rows
  --rejects PATH       Where the rows that cannot be imported go. Default: <file>.rejects.jsonl
  --include A,B        Only these columns become properties
  --exclude A,B        Columns that never become properties
  --text A,B           Keep these CSV columns as text, also when they look like numbers
  --strings            Keep every CSV value as text
  --format csv|jsonl   Default: from the file extension
  --delimiter ";"      For a CSV file. \\t for a tab
  --batch-size N       Rows in one request, 1 to 500

A column that ends in _id names an entity: device_id is the entity device. Every other column is a property.
It exits with 0 when it ran to the end (also with rejected rows), 1 when it stopped, and 2 for a wrong command.
See docs/getting-started/import-history.md.`;

export const importHistory: Command = async (args, ctx) => {
  const [kind, ...rest] = args;
  const sub = kind === "events" ? events : kind === "entities" ? entities : kind === "labels" ? labels : undefined;
  if (!sub) {
    if (kind && kind !== "--help" && kind !== "help")
      throw usage(`Unknown: kairos import ${kind}. Use events, entities or labels.`);
    console.log(IMPORT_HELP);
    return;
  }
  await sub(rest, ctx);
};
