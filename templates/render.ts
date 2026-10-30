/**
 * Writes one Markdown page for each event template, in docs/templates/events/.
 *
 *   pnpm docs:events
 *
 * The JSON file is the source. A test fails when a page does not match its file, so edit
 * the JSON and run this again; do not edit the pages by hand.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventTemplate } from "../packages/core/src/templates";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export function loadEventTemplates(): EventTemplate[] {
  const dir = here("./events/");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(dir + f, "utf8")));
}

const startsDecision = (t: EventTemplate) => t.type.endsWith("_requested");

/** The SDK call for a template's example. */
export function exampleCode(t: EventTemplate): string {
  const call = startsDecision(t) ? "const decision = await kairos.trackAndDecide" : "kairos.track";
  const lines = Object.entries(t.example).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`);
  return `${call}("${t.type}", {\n${lines.join("\n")}\n});`;
}

/** A second stage of the same record, with only what changed. */
function laterStage(t: EventTemplate): string | undefined {
  if (!t.record) return undefined;
  const subject = Object.keys(t.example).find((k) => /Id$/.test(k) && k !== "universalId")!;
  const next = t.record.statuses[t.record.statuses.indexOf(String(t.example.status)) + 1];
  if (!next) return undefined;
  return `kairos.track("${t.type}", {\n  ${subject}: ${JSON.stringify(t.example[subject])},\n  universalId: ${JSON.stringify(t.example.universalId)},\n  status: ${JSON.stringify(next)},\n});`;
}

const cell = (text: string) => text.replaceAll("|", "\\|");

/** "login_failed" → "Login Failed": the name of an event type for people. */
export const titleOf = (type: string) =>
  type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

export function renderEventDoc(t: EventTemplate): string {
  const out: string[] = [
    `<!-- Generated from templates/events/${t.type}.json by pnpm docs:events. Edit that file, not this page. -->`,
    "",
    `# ${titleOf(t.type)}`,
    "",
    t.description,
    "",
    `Event type: \`${t.type}\``,
    "",
  ];
  if (t.record)
    out.push(
      "**A record with stages.** Send every stage with the same `universalId` and its `status`. See [Records that change](../../reference/clients/typescript.md#records-that-change).",
      "",
    );
  if (startsDecision(t))
    out.push(
      "**Starts a decision.** Send it with `trackAndDecide`, and give an action this event as its `trigger`. See [Decide from an event](../../reference/clients/typescript.md#decide-from-an-event).",
      "",
    );

  out.push("## Fields", "", "| Field | Type | Required | Meaning |", "|---|---|---|---|");
  for (const [name, e] of Object.entries(t.entities)) {
    const key = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out.push(`| \`${key}Id\` | entity \`${name}\` | ${e.required ? "yes" : "no"} | ${cell(e.description)} |`);
  }
  if (t.record) {
    out.push(
      `| \`universalId\` | record id | yes | The same id for every stage of this record. Use your own identifier. |`,
    );
    out.push(`| \`status\` | string | yes | The stage: ${t.record.statuses.map((s) => `\`${s}\``).join(", ")}. |`);
  }
  for (const [name, p] of Object.entries(t.properties)) {
    const values = p.enum ? ` One of ${p.enum.map((v) => `\`${v}\``).join(", ")}.` : "";
    out.push(`| \`${name}\` | ${p.type} | no | ${cell(p.description)}${values} |`);
  }
  out.push(
    "",
    "A field that ends in `Id` names an entity: the event joins that entity's history, and two subjects that name the same one become linked. Every other field is stored as given. You may add fields of your own.",
    "",
  );

  out.push("## Example", "", "```ts", exampleCode(t), "```", "");
  const later = laterStage(t);
  if (t.record) {
    out.push("## Stages", "");
    if (t.record.description) out.push(t.record.description, "");
    if (later) out.push("A later stage of the same record:", "", "```ts", later, "```", "");
    out.push(
      "Every stage is stored. A decision sees one record in its latest state, with the statuses it went through.",
      "",
    );
  }

  out.push(
    "---",
    "",
    "A template is a recommendation. Kairos accepts any event type and any fields, and checks no event against a template. [All templates](../overview.md)",
    "",
  );
  return out.join("\n");
}

export function renderIndex(templates: EventTemplate[]): string {
  const out = [
    "<!-- Generated from templates/events/ by pnpm docs:events. Edit those files, not this page. -->",
    "",
    "# Event templates",
    "",
    "Recommended shapes for common events, one page each. Kairos accepts any event, so none of these is required. [About templates](../overview.md#event-shapes)",
    "",
    "| Event | Type | What it is | |",
    "|---|---|---|---|",
  ];
  for (const t of templates) {
    const tag = t.record ? "record with stages" : startsDecision(t) ? "starts a decision" : "";
    out.push(
      `| [${titleOf(t.type)}](${t.type}.md) | \`${t.type}\` | ${cell(t.description.split(". ")[0]!.replace(/\.$/, ""))}. | ${tag} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

/** Path of each generated page, relative to docs/templates/events/, with its content. */
export function eventDocs(): Record<string, string> {
  const templates = loadEventTemplates();
  return Object.fromEntries([
    ["README.md", renderIndex(templates)],
    ...templates.map((t) => [`${t.type}.md`, renderEventDoc(t)] as const),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = here("../docs/templates/events/");
  mkdirSync(dir, { recursive: true });
  const docs = eventDocs();
  for (const [file, content] of Object.entries(docs)) writeFileSync(dir + file, content);
  console.log(`Wrote ${Object.keys(docs).length} pages to docs/templates/events/`);
}
