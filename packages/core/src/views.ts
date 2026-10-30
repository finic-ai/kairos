import {
  COLUMN_FORMATS,
  validateFacts,
  validateLists,
  type ColumnFormat,
  type EntityFact,
  type EntityList,
  type ListColumn,
} from "./facts";

export const BLOCK_TYPES = [
  "evidence",
  "decisions",
  "timeline",
  "details",
  "fields",
  "facts",
  "list",
  "objects",
  "activity",
  "text",
  "images",
  "documents",
  "checklist",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export const VIEW_REGIONS = ["main", "side"] as const;
export type ViewRegion = (typeof VIEW_REGIONS)[number];

export const MAX_BLOCKS = 24;
export const MAX_HEADER_FIELDS = 6;
export const MAX_BLOCK_FIELDS = 16;
export const MAX_MEDIA = 8;
export const MAX_POINTS = 12;
export const MAX_MEDIA_HOSTS = 20;
export const MIN_WIDTH = 3;
/** The block types a view cannot leave out: the evidence is why the case exists. */
export const REQUIRED_BLOCKS: BlockType[] = ["evidence"];

export type ViewField = string | ListColumn;

export interface ViewBlock {
  id: string;
  type: BlockType;
  region: ViewRegion;
  /** In the main region, the width in twelfths. Default 12. */
  w?: number;
  title?: string;
  /** Facts and list: the entity, "case.target" (the default) or "item.<entity type>". */
  of?: string;
  /** Fields; and for images and documents, the fields that hold their addresses. */
  fields?: ViewField[];
  /** Images and documents: blurred, or closed, until a person opens them, and each opening is recorded. Default true. */
  sensitive?: boolean;
  points?: string[];
  /** Facts: the names to show, in order. Without them, every fact for the entity. */
  facts?: string[];
  /** List: the lists to show as tabs, in order. Without them, every list for the entity. */
  lists?: string[];
  /** List: rows to a page, 3 to 25. */
  rows?: number;
  text?: string;
}

export type ViewFact = EntityFact & { for: string };
export type ViewList = EntityList & { for: string };

export interface CaseView {
  /** The template it was made from, for people. A later change to the template does not change the view. */
  template?: string;
  header?: ViewField[];
  blocks: ViewBlock[];
  /** Facts and lists of the view. A name here replaces the same name of the entity type, in this view. */
  facts?: ViewFact[];
  lists?: ViewList[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CASE_FIELDS = ["status", "priority", "assignee", "queue", "opened", "age", "due", "reason"];
const DECISION_FIELDS = ["outcome", "risk_score", "action", "typology"];
/** The fields with a fixed path. The others take a name: `signal.`, `request.`, `event.`, `subject.`, `item.<type>.`. */
export const VIEW_FIELDS = [...CASE_FIELDS.map((f) => `case.${f}`), ...DECISION_FIELDS.map((f) => `decision.${f}`)];
export const VIEW_FIELD_PREFIXES = ["request.", "event.", "subject.", "signal.", "item."];

export function isViewPath(path: string): boolean {
  const [head, a, b, ...rest] = path.split(".");
  if (rest.length) return false;
  if (head === "case") return b === undefined && CASE_FIELDS.includes(a ?? "");
  if (head === "decision") return b === undefined && DECISION_FIELDS.includes(a ?? "");
  if (head === "signal" || head === "request" || head === "event" || head === "subject")
    return b === undefined && NAME.test(a ?? "");
  if (head === "item") return NAME.test(a ?? "") && NAME.test(b ?? "");
  return false;
}

const FIELD_TITLE: Record<string, string> = {
  "case.status": "Status",
  "case.priority": "Priority",
  "case.assignee": "Assignee",
  "case.queue": "Queue",
  "case.opened": "Opened",
  "case.age": "Waiting",
  "case.due": "Due",
  "case.reason": "Why",
  "decision.outcome": "Outcome",
  "decision.risk_score": "Risk",
  "decision.action": "Action",
  "decision.typology": "Typology",
};

export function viewFieldTitle(field: ViewField): string {
  const f = typeof field === "string" ? { field } : field;
  if (f.label?.trim()) return f.label.trim();
  if (FIELD_TITLE[f.field]) return FIELD_TITLE[f.field]!;
  const [head, ...rest] = f.field.split(".");
  const text = (head === "signal" ? `${rest.join(" ")} signal` : rest.join(" ")).replaceAll("_", " ");
  return text[0]!.toUpperCase() + text.slice(1);
}

export const isEntityPath = (path: string) =>
  path === "case.target" || (path.startsWith("item.") && NAME.test(path.slice(5)));

function fieldProblems(at: string, fields: unknown, max: number): string[] {
  if (!Array.isArray(fields) || fields.length > max) return [`${at} must be a list of at most ${max} fields`];
  const problems: string[] = [];
  for (const [i, raw] of fields.entries()) {
    const f = (typeof raw === "string" ? { field: raw } : raw) as Partial<ListColumn> | null;
    if (!f || typeof f.field !== "string" || !isViewPath(f.field))
      problems.push(
        `${at}[${i}] must be a path such as case.priority, decision.risk_score, signal.<code>, request.<property>, event.<property>, subject.<property> or item.<type>.<property>`,
      );
    else {
      if (f.label !== undefined && (typeof f.label !== "string" || f.label.length > 80))
        problems.push(`${at}[${i}].label must be text of at most 80 characters`);
      if (f.format !== undefined && !COLUMN_FORMATS.includes(f.format as ColumnFormat))
        problems.push(`${at}[${i}].format must be one of ${COLUMN_FORMATS.join(", ")}`);
    }
  }
  return problems;
}

function ownedProblems(at: string, items: unknown, check: (items: unknown, at: string) => string[]): string[] {
  if (items === undefined) return [];
  if (!Array.isArray(items)) return [`${at} must be a list`];
  const problems: string[] = [];
  const byType = new Map<string, unknown[]>();
  for (const [i, item] of items.entries()) {
    const owner = (item as { for?: unknown } | null)?.for;
    if (typeof owner !== "string" || !NAME.test(owner)) problems.push(`${at}[${i}].for must be an entity type`);
    else byType.set(owner, [...(byType.get(owner) ?? []), item]);
  }
  // Each type's facts or lists are checked as an entity type's are, so the limits are per type.
  for (const [type, list] of byType)
    problems.push(
      ...check(
        list.map((item) => ({ ...(item as object), for: undefined })),
        `${at} for ${type}`,
      ),
    );
  return problems;
}

export function validateView(view: unknown, at = "view"): string[] {
  if (!view || typeof view !== "object" || Array.isArray(view)) return [`${at} must be an object`];
  const v = view as Partial<CaseView>;
  const problems: string[] = [];
  if (v.template !== undefined && (typeof v.template !== "string" || !NAME.test(v.template)))
    problems.push(`${at}.template must be a name`);
  if (v.header !== undefined) problems.push(...fieldProblems(`${at}.header`, v.header, MAX_HEADER_FIELDS));
  if (!Array.isArray(v.blocks) || v.blocks.length === 0 || v.blocks.length > MAX_BLOCKS) {
    problems.push(`${at}.blocks must be a list of 1 to ${MAX_BLOCKS} blocks`);
  } else {
    const ids = new Set<string>();
    for (const [i, raw] of v.blocks.entries()) {
      const here = `${at}.blocks[${i}]`;
      const b = raw as Partial<ViewBlock> | null;
      if (!b || typeof b !== "object") {
        problems.push(`${here} must be an object`);
        continue;
      }
      if (typeof b.id !== "string" || !NAME.test(b.id)) problems.push(`${here}.id must be a name`);
      else if (ids.has(b.id)) problems.push(`${here}.id: "${b.id}" is used twice`);
      else ids.add(b.id);
      if (!BLOCK_TYPES.includes(b.type as BlockType)) {
        problems.push(`${here}.type must be one of ${BLOCK_TYPES.join(", ")}`);
        continue;
      }
      if (!VIEW_REGIONS.includes(b.region as ViewRegion)) problems.push(`${here}.region must be main or side`);
      if (b.w !== undefined && (!Number.isInteger(b.w) || b.w < MIN_WIDTH || b.w > 12))
        problems.push(`${here}.w must be a whole number from ${MIN_WIDTH} to 12`);
      if (b.title !== undefined && (typeof b.title !== "string" || b.title.length > 80))
        problems.push(`${here}.title must be text of at most 80 characters`);
      const takes = (key: keyof ViewBlock, types: BlockType[]) =>
        b[key] !== undefined &&
        !types.includes(b.type!) &&
        problems.push(`${here}.${key} is only for ${types.join(" and ")}`);
      takes("of", ["facts", "list"]);
      takes("fields", ["fields", "images", "documents"]);
      takes("sensitive", ["images", "documents"]);
      takes("points", ["checklist"]);
      takes("facts", ["facts"]);
      takes("lists", ["list"]);
      takes("rows", ["list"]);
      takes("text", ["text"]);
      if (b.of !== undefined && (typeof b.of !== "string" || !isEntityPath(b.of)))
        problems.push(`${here}.of must be case.target or item.<entity type>`);
      if (b.type === "fields") problems.push(...fieldProblems(`${here}.fields`, b.fields, MAX_BLOCK_FIELDS));
      if (b.type === "images" || b.type === "documents") {
        if (!Array.isArray(b.fields) || b.fields.length === 0)
          problems.push(`${here}.fields must name 1 to ${MAX_MEDIA} fields that hold an address`);
        else problems.push(...fieldProblems(`${here}.fields`, b.fields, MAX_MEDIA));
      }
      if (b.sensitive !== undefined && typeof b.sensitive !== "boolean")
        problems.push(`${here}.sensitive must be true or false`);
      if (
        b.type === "checklist" &&
        (!Array.isArray(b.points) ||
          b.points.length === 0 ||
          b.points.length > MAX_POINTS ||
          !b.points.every((p) => typeof p === "string" && p.trim() && p.length <= 200) ||
          new Set(b.points).size !== b.points.length)
      )
        problems.push(`${here}.points must be 1 to ${MAX_POINTS} different points of at most 200 characters`);
      for (const key of ["facts", "lists"] as const)
        if (
          b[key] !== undefined &&
          (!Array.isArray(b[key]) || !b[key]!.every((n) => typeof n === "string" && NAME.test(n)))
        )
          problems.push(`${here}.${key} must be a list of names`);
      if (b.rows !== undefined && (!Number.isInteger(b.rows) || b.rows < 3 || b.rows > 25))
        problems.push(`${here}.rows must be a whole number from 3 to 25`);
      if (b.type === "text" && (typeof b.text !== "string" || !b.text.trim() || b.text.length > 2000))
        problems.push(`${here}.text must be text of 1 to 2,000 characters`);
    }
    for (const type of REQUIRED_BLOCKS)
      if (!v.blocks.some((b) => (b as ViewBlock | null)?.type === type))
        problems.push(`${at}.blocks must have the ${type} block: it says why the case exists`);
  }
  problems.push(...ownedProblems(`${at}.facts`, v.facts, validateFacts));
  problems.push(...ownedProblems(`${at}.lists`, v.lists, validateLists));
  return problems;
}

const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The problems of a list of approved hosts: names such as "files.example.com", or "*.example.com" for every subdomain. */
export function validateHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts) || hosts.length > MAX_MEDIA_HOSTS)
    return [`hosts must be a list of at most ${MAX_MEDIA_HOSTS}`];
  return hosts
    .map((h, i) =>
      typeof h === "string" && HOST.test(h)
        ? null
        : `hosts[${i}] must be a host such as files.example.com or *.example.com`,
    )
    .filter((p): p is string => p !== null);
}

/** Whether a host is one of the approved: the same name, or under a "*." entry (not the bare domain). */
export function hostApproved(host: string, approved: string[]): boolean {
  const name = host.toLowerCase();
  return approved.some((a) => (a.startsWith("*.") ? name.endsWith(a.slice(1)) : name === a));
}

/** The definitions a block reads: the view's own for the entity's type, else the type's. A view's name replaces the type's. */
export function definitionsFor<T extends { name: string }>(
  own: (T & { for: string })[] | undefined,
  type: string,
  ofType: T[] | undefined,
  names: string[] | undefined,
): T[] {
  const mine = (own ?? []).filter((d) => d.for === type);
  const all = [...mine, ...(ofType ?? []).filter((d) => !mine.some((m) => m.name === d.name))];
  if (!names?.length) return mine.length ? mine : (ofType ?? []);
  return names.map((n) => all.find((d) => d.name === n)).filter((d): d is T => d !== undefined);
}

export const DEFAULT_VIEW: CaseView = {
  blocks: [
    { id: "evidence", type: "evidence", region: "main" },
    { id: "decisions", type: "decisions", region: "main" },
    { id: "lists", type: "list", region: "main" },
    { id: "timeline", type: "timeline", region: "main" },
    { id: "facts", type: "facts", region: "side" },
    { id: "details", type: "details", region: "side" },
    { id: "objects", type: "objects", region: "side" },
    { id: "activity", type: "activity", region: "side" },
  ],
};
