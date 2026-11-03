import { parse } from "@bufbuild/cel";
import {
  rulesetListSlugs,
  rulesetSlugProblem,
  validateRuleset,
  type ListMatcher,
  type RulesetDefinition,
  type RulesetResult,
} from "@kairos/core";
import type { Executor } from "../../platform/database";
import { invalid, notFound } from "../../platform/error";
import { saveVersion } from "../../services/definition_version.service";
import { ListsService } from "../../services/list.service";
import { RULESET_ID, RulesetsService, type RulesetView } from "../../services/ruleset.service";
import { evaluateRuleset, publishProblems, RulesetError, runTest, type TestResult } from "./libs";
import type { DraftBody, UpdateBody } from "./schema";

type Scope = { workspaceId: string; environmentId: string };

/** A draft is at most this big, as JSON: about ten times a ruleset of 50 rules. */
const MAX_DRAFT_BYTES = 256 * 1024;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The optional lists of a definition filled in, so that two drafts that mean the same are the same. */
const complete = (definition: Record<string, unknown>): RulesetDefinition =>
  ({ inputs: [], tests: [], ...definition }) as unknown as RulesetDefinition;

const missingRuleset = (ref: string) => notFound(`No ruleset "${ref}"`);

async function current(db: Executor, scope: Scope, ref: string) {
  const row = await new RulesetsService(db, scope).findRow(ref);
  if (row?.status === "archived") throw invalid(`the ruleset "${row.slug}" is archived: restore it first`);
  return row;
}

export async function loadLists(db: Executor, scope: Scope, slugs: readonly string[]) {
  const rows = await new ListsService(db, scope).bySlugs(slugs);
  return new Map<string, ListMatcher>(
    rows.map((r) => [r.slug, { match: r.match, case_sensitive: r.caseSensitive, items: r.items }]),
  );
}

export async function listRulesets(
  db: Executor,
  scope: Scope,
  { archived, q, limit, offset }: { archived: boolean; q: string; limit: number; offset: number },
) {
  return new RulesetsService(db, scope).list(archived, q, limit, offset);
}

export async function getRuleset(db: Executor, scope: Scope, ref: string, version?: number): Promise<RulesetView> {
  const rulesets = new RulesetsService(db, scope);
  const found = await rulesets.find(ref);
  if (!found) throw missingRuleset(ref);
  if (version === undefined || version === found.version) return found;
  const definition = await rulesets.findVersion(found.slug, version);
  if (!definition) throw notFound(`No version ${version} of the ruleset "${found.slug}"`);
  const { draft: _draft, ...rest } = found;
  return { ...rest, version, definition };
}

export async function listVersions(db: Executor, scope: Scope, ref: string) {
  const rulesets = new RulesetsService(db, scope);
  const found = await rulesets.findRow(ref);
  if (!found) throw missingRuleset(ref);
  return { versions: await rulesets.listVersions(found.slug) };
}

/**
 * Save changes as the draft. Nothing evaluates a draft, so it can still have problems; a publish
 * checks it. A new slug makes a ruleset, at version 0. A draft equal to the live version is no draft.
 */
export async function saveDraft(
  db: Executor,
  scope: Scope,
  ref: string,
  body: DraftBody,
  by: string | null,
  now: Date,
): Promise<{ ruleset: RulesetView; created: boolean }> {
  const draft = complete(body.definition);
  if (Buffer.byteLength(JSON.stringify(draft)) > MAX_DRAFT_BYTES) throw invalid("the ruleset is too big to save");
  return db.transaction(async (tx) => {
    const rulesets = new RulesetsService(tx, scope);
    const row = await current(tx, scope, ref);
    if (!row) {
      if (RULESET_ID.test(ref)) throw missingRuleset(ref);
      const problem = rulesetSlugProblem(ref);
      if (problem) throw invalid(`slug: "${ref}" ${problem}`);
      if (!body.name) throw invalid("name: needed for a new ruleset");
      await rulesets.create(
        {
          slug: ref,
          name: body.name,
          description: body.description ?? null,
          version: 0,
          definition: draft,
          draft,
          status: "draft",
          createdBy: by,
          updatedBy: by,
        },
        now,
      );
      return { ruleset: (await rulesets.find(ref))!, created: true };
    }
    await rulesets.updateMany(
      { id: row.id },
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        // A ruleset that was never published keeps its draft, even when it equals the empty start.
        draft: row.version > 0 && same(draft, row.definition) ? null : draft,
        ...(row.version === 0 ? { definition: draft } : {}),
        updatedBy: by,
      },
      now,
    );
    return { ruleset: (await rulesets.find(row.id))!, created: false };
  });
}

export async function publishRuleset(
  db: Executor,
  scope: Scope,
  ref: string,
  by: string | null,
  now: Date,
): Promise<RulesetView> {
  const row = await current(db, scope, ref);
  if (!row) throw missingRuleset(ref);
  if (!row.draft && row.version > 0) throw invalid("there are no changes to publish");
  const definition = complete((row.draft ?? row.definition) as unknown as Record<string, unknown>);
  const slugs = validateRuleset(definition).length ? [] : rulesetListSlugs(definition);
  const problems = publishProblems(definition, await loadLists(db, scope, slugs), slugs);
  if (problems.length) throw invalid(problems.join("; "));
  return db.transaction(async (tx) => {
    const saved = await saveVersion(
      tx,
      scope,
      "ruleset",
      row.slug,
      definition as unknown as Record<string, unknown>,
      by,
      now,
    );
    const rulesets = new RulesetsService(tx, scope);
    await rulesets.updateMany(
      { id: row.id },
      {
        version: saved.version,
        definition,
        draft: null,
        status: "published",
        publishedAt: now,
        updatedBy: by,
      },
      now,
    );
    return (await rulesets.find(row.id))!;
  });
}

export async function discardDraft(db: Executor, scope: Scope, ref: string, by: string | null, now: Date) {
  const row = await current(db, scope, ref);
  if (!row) throw missingRuleset(ref);
  if (row.version === 0) throw invalid("the ruleset was never published: archive it instead");
  const rulesets = new RulesetsService(db, scope);
  await rulesets.updateMany({ id: row.id }, { draft: null, updatedBy: by }, now);
  return (await rulesets.find(row.id))!;
}

/** The name, the description and the settings: none of them is a version. */
export async function updateRuleset(
  db: Executor,
  scope: Scope,
  ref: string,
  change: UpdateBody,
  by: string | null,
  now: Date,
) {
  const rulesets = new RulesetsService(db, scope);
  const row = await rulesets.findRow(ref);
  if (!row) throw missingRuleset(ref);
  await rulesets.updateMany(
    { id: row.id },
    {
      ...(change.name !== undefined ? { name: change.name } : {}),
      ...(change.description !== undefined ? { description: change.description } : {}),
      ...(change.settings !== undefined ? { settings: change.settings } : {}),
      updatedBy: by,
    },
    now,
  );
  return (await rulesets.find(row.id))!;
}

/** An archived ruleset gets no new references. Its versions stay, so the references to them still work. */
export async function setArchived(
  db: Executor,
  scope: Scope,
  ref: string,
  archived: boolean,
  by: string | null,
  now: Date,
) {
  const rulesets = new RulesetsService(db, scope);
  const row = await rulesets.findRow(ref);
  if (!row) throw missingRuleset(ref);
  const status = archived ? "archived" : row.version > 0 ? "published" : "draft";
  await rulesets.updateMany({ id: row.id }, { status, updatedBy: by }, now);
  return (await rulesets.find(row.id))!;
}

/** Evaluate the live version, or another one. An archived ruleset still evaluates. */
export async function evaluate(
  db: Executor,
  scope: Scope,
  ref: string,
  version: number | undefined,
  input: Record<string, unknown>,
): Promise<RulesetResult> {
  const rulesets = new RulesetsService(db, scope);
  const row = await rulesets.findRow(ref);
  if (!row) throw missingRuleset(ref);
  const at = version ?? row.version;
  if (at === 0) throw invalid(`the ruleset "${row.slug}" was never published`);
  const definition = at === row.version ? row.definition : await rulesets.findVersion(row.slug, at);
  if (!definition) throw notFound(`No version ${at} of the ruleset "${row.slug}"`);
  const lists = await loadLists(db, scope, rulesetListSlugs(definition));
  try {
    return evaluateRuleset(`${row.slug}@${at}`, definition, input, lists);
  } catch (cause) {
    if (cause instanceof RulesetError) throw invalid(cause.message);
    throw cause;
  }
}

export interface TestRun {
  /** The problems that would stop a publish, apart from the tests. */
  problems: string[];
  result?: RulesetResult;
  error?: string;
  tests: TestResult[];
}

/** Evaluate a definition that is not saved, with an input, and run its tests. Nothing is written. */
export async function testDefinition(
  db: Executor,
  scope: Scope,
  body: Record<string, unknown>,
  input: Record<string, unknown> | undefined,
): Promise<TestRun> {
  const definition = complete(body);
  const shape = validateRuleset(definition);
  if (shape.length) return { problems: shape, tests: [] };
  const problems: string[] = [];
  for (const rule of definition.rules) {
    try {
      parse(rule.when);
    } catch (cause) {
      problems.push(`rules.${rule.id}.when: ${(cause as Error).message}`);
    }
  }
  const slugs = rulesetListSlugs(definition);
  const lists = await loadLists(db, scope, slugs);
  for (const slug of slugs) if (!lists.has(slug)) problems.push(`rules: there is no list "${slug}"`);
  if (problems.length) return { problems, tests: [] };
  const tests = definition.tests.map((test) => runTest(definition, test, lists));
  if (!input) return { problems, tests };
  try {
    return { problems, tests, result: evaluateRuleset("draft", definition, input, lists) };
  } catch (cause) {
    return { problems, tests, error: (cause as Error).message };
  }
}

const REF = /^([a-z][a-z0-9_]{0,63})(?:@([1-9]\d*))?$/;

/** `slug` or `slug@version`, or null when it is not one. */
export function parseRulesetRef(ref: string): { slug: string; version?: number } | null {
  const match = REF.exec(ref);
  if (!match) return null;
  return match[2] ? { slug: match[1]!, version: Number(match[2]) } : { slug: match[1]! };
}

/** Evaluate `slug`, the live version, or `slug@version`. */
export async function evaluateRef(db: Executor, scope: Scope, ref: string, input: Record<string, unknown>) {
  const parsed = parseRulesetRef(ref);
  if (!parsed) throw invalid(`ruleset: "${ref}" is not a ruleset's slug, or a slug and a version`);
  return evaluate(db, scope, parsed.slug, parsed.version, input);
}

/** What a step that names a ruleset can use of it, or why it cannot use it. */
export async function describeRuleset(
  db: Executor,
  scope: Scope,
  ref: string,
): Promise<{ inputs: RulesetDefinition["inputs"] } | string> {
  const parsed = parseRulesetRef(ref);
  if (!parsed) return `"${ref}" is not a ruleset's slug, or a slug and a version such as "high_risk_payout@2"`;
  const rulesets = new RulesetsService(db, scope);
  const row = await rulesets.findRow(parsed.slug);
  if (!row) return `there is no ruleset "${parsed.slug}"`;
  if (row.status === "archived") return `the ruleset "${parsed.slug}" is archived`;
  if (row.version === 0) return `the ruleset "${parsed.slug}" was never published`;
  const version = parsed.version ?? row.version;
  const definition = version === row.version ? row.definition : await rulesets.findVersion(parsed.slug, version);
  if (!definition) return `there is no version ${version} of the ruleset "${parsed.slug}"`;
  return { inputs: definition.inputs };
}
