import {
  itemKey,
  listSlugsIn,
  listSlugProblem,
  MAX_LIST_ITEMS,
  normalizeItem,
  rulesetListSlugs,
  type ItemMatch,
  type ListItem,
} from "@kairos/core";
import type { ListRow } from "../../db/schema";
import type { Executor } from "../../platform/database";
import { AppError, invalid, notFound } from "../../platform/error";
import { LIST_ID, ListsService, toListDetail, type ListDetail } from "../../services/list.service";
import { RulesetsService } from "../../services/ruleset.service";
import { WorkflowsService } from "../../services/workflow.service";
import type { ListQuery, PutBody } from "./schema";
import type { ItemInput } from "./types";

type Scope = { workspaceId: string; environmentId: string };

const MAX_ITEMS_BYTES = 1024 * 1024;

const missingList = (ref: string) => notFound(`No list "${ref}"`);
const defaultsOf = (row: ListRow): ItemMatch => ({ match: row.match, case_sensitive: row.caseSensitive });

export async function listLists(db: Executor, scope: Scope, { q, limit, offset }: ListQuery) {
  return new ListsService(db, scope).list(q, limit, offset);
}

export async function getList(db: Executor, scope: Scope, ref: string): Promise<ListDetail> {
  const row = await new ListsService(db, scope).findRow(ref);
  if (!row) throw missingList(ref);
  return toListDetail(row);
}

/** The items of a call as the list keeps them. Throws with every value that cannot be an item. */
function toItems(input: ItemInput[], by: string | null, now: Date): ListItem[] {
  const problems: string[] = [];
  const items = input.flatMap((given, i) => {
    const result = normalizeItem(given.value);
    if ("problem" in result) return (problems.push(`items.${i}.value: ${result.problem}`), []);
    return [
      {
        value: result.value,
        ...(given.match ? { match: given.match } : {}),
        ...(typeof given.case_sensitive === "boolean" ? { case_sensitive: given.case_sensitive } : {}),
        ...(given.note ? { note: given.note } : {}),
        ...(by ? { added_by: by } : {}),
        added: now.toISOString(),
      },
    ];
  });
  if (problems.length) throw invalid(problems.join("; "));
  return items;
}

/** One item for each key: a later item takes the place of an earlier one with the same key. */
function merge(list: ItemMatch, existing: readonly ListItem[], added: readonly ListItem[]) {
  const items = new Map(existing.map((i) => [itemKey(list, i), i]));
  let fresh = 0;
  let updated = 0;
  for (const item of added) {
    const key = itemKey(list, item);
    const before = items.get(key);
    if (!before) fresh++;
    else updated++;
    // An item that is there already keeps when and by whom it was first added.
    items.set(key, before ? { ...item, added: before.added, added_by: before.added_by } : item);
  }
  return { items: [...items.values()], added: fresh, updated };
}

function checkSize(items: readonly ListItem[]) {
  if (items.length > MAX_LIST_ITEMS)
    throw invalid(`items: a list has at most ${MAX_LIST_ITEMS.toLocaleString()} items`);
  if (Buffer.byteLength(JSON.stringify(items)) > MAX_ITEMS_BYTES)
    throw invalid("items: a list has at most 1 MB of items");
}

/** Create a list, or change its name, description, or the match and case of its items that have none of their own. */
export async function putList(
  db: Executor,
  scope: Scope,
  ref: string,
  body: PutBody,
  by: string | null,
  now: Date,
): Promise<{ list: ListDetail; created: boolean }> {
  return db.transaction(async (tx) => {
    const lists = new ListsService(tx, scope);
    const row = await lists.findRow(ref);
    if (!row) {
      if (LIST_ID.test(ref)) throw missingList(ref);
      const problem = listSlugProblem(ref);
      if (problem) throw invalid(`slug: "${ref}" ${problem}`);
      if (!body.name) throw invalid("name: needed for a new list");
      await lists.create(
        {
          slug: ref,
          name: body.name,
          description: body.description ?? null,
          match: body.match ?? "exact",
          caseSensitive: body.case_sensitive ?? false,
          items: [],
          createdBy: by,
          updatedBy: by,
        },
        now,
      );
      return { list: toListDetail((await lists.findRow(ref))!), created: true };
    }
    await lists.lockSlug(row.slug);
    const fresh = (await lists.findRow(row.id))!;
    const defaults = { match: body.match ?? fresh.match, case_sensitive: body.case_sensitive ?? fresh.caseSensitive };
    if (merge(defaults, [], fresh.items).items.length < fresh.items.length)
      throw invalid("case_sensitive: two items of the list differ only in case: remove one first");
    await lists.updateMany(
      { id: row.id },
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        match: defaults.match,
        caseSensitive: defaults.case_sensitive,
        updatedBy: by,
      },
      now,
    );
    return { list: toListDetail((await lists.findRow(row.id))!), created: false };
  });
}

async function change<T>(
  db: Executor,
  scope: Scope,
  ref: string,
  by: string | null,
  now: Date,
  next: (row: ListRow) => { items: ListItem[] } & T,
): Promise<{ list: ListDetail } & T> {
  return db.transaction(async (tx) => {
    const lists = new ListsService(tx, scope);
    const found = await lists.findRow(ref);
    if (!found) throw missingList(ref);
    await lists.lockSlug(found.slug);
    const row = (await lists.findRow(found.id))!;
    const { items, ...rest } = next(row);
    checkSize(items);
    await lists.updateMany({ id: row.id }, { items, updatedBy: by }, now);
    return { ...(rest as T), list: toListDetail((await lists.findRow(row.id))!) };
  });
}

/** An item that is on the list already takes the match, case and note of the call. */
export async function addItems(
  db: Executor,
  scope: Scope,
  ref: string,
  body: ItemInput[],
  by: string | null,
  now: Date,
) {
  return change(db, scope, ref, by, now, (row) => merge(defaultsOf(row), row.items, toItems(body, by, now)));
}

export async function removeItems(
  db: Executor,
  scope: Scope,
  ref: string,
  values: (string | number)[],
  by: string | null,
  now: Date,
) {
  return change(db, scope, ref, by, now, (row) => {
    const defaults = defaultsOf(row);
    const gone = values.flatMap((v) => {
      const result = normalizeItem(v);
      return "value" in result ? [result.value] : [];
    });
    const items = row.items.filter(
      (i) => !gone.some((value) => itemKey(defaults, { ...i, value }) === itemKey(defaults, i)),
    );
    return { items, removed: row.items.length - items.length };
  });
}

/** All the items at once, for a sync from another system. */
export async function replaceItems(
  db: Executor,
  scope: Scope,
  ref: string,
  body: ItemInput[],
  by: string | null,
  now: Date,
) {
  return change(db, scope, ref, by, now, (row) => ({
    items: merge(defaultsOf(row), [], toItems(body, by, now)).items,
  }));
}

/** The slugs of the lists that a workflow reads with `inList` or changes with a list step. */
function listsOfWorkflow(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") for (const slug of listSlugsIn(value)) into.add(slug);
  else if (Array.isArray(value)) for (const v of value) listsOfWorkflow(v, into);
  else if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    if (typeof node.type === "string" && node.type.startsWith("list.") && typeof node.list === "string")
      into.add(node.list);
    for (const v of Object.values(node)) listsOfWorkflow(v, into);
  }
  return into;
}

/** The rulesets and the workflows whose live version or draft reads or changes the list. Archived ones do not count. */
async function readersOf(db: Executor, scope: Scope, slug: string) {
  const [rulesets, workflows] = await Promise.all([
    new RulesetsService(db, scope).listLive(),
    new WorkflowsService(db, scope).listAll(),
  ]);
  return {
    rulesets: rulesets
      .filter((r) => [r.definition, r.draft].some((d) => d && rulesetListSlugs(d).includes(slug)))
      .map((r) => ({ slug: r.slug, name: r.name })),
    workflows: workflows
      .filter((w) => listsOfWorkflow([w.trigger, w.steps, w.draft]).has(slug))
      .map((w) => ({ name: w.name, ...(w.displayName ? { display_name: w.displayName } : {}) })),
  };
}

export async function deleteList(db: Executor, scope: Scope, ref: string): Promise<ListDetail> {
  const lists = new ListsService(db, scope);
  const row = await lists.findRow(ref);
  if (!row) throw missingList(ref);
  const { rulesets, workflows } = await readersOf(db, scope, row.slug);
  const readers = [
    ...rulesets.map((r) => `the ruleset "${r.name}"`),
    ...workflows.map((w) => `the workflow "${w.display_name ?? w.name}"`),
  ];
  if (readers.length)
    throw new AppError(
      "conflict",
      "conflict",
      `The list "${row.slug}" is used by ${readers.join(", ")}: change ${readers.length > 1 ? "them" : "it"} first`,
    );
  await lists.delete(row.id);
  return toListDetail(row);
}

export async function listReaders(db: Executor, scope: Scope, ref: string) {
  const row = await new ListsService(db, scope).findRow(ref);
  if (!row) throw missingList(ref);
  return readersOf(db, scope, row.slug);
}
