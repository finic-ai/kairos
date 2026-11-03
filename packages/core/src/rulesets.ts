export const RULESET_OUTCOMES = ["approve", "reject"] as const;
export type RulesetOutcome = (typeof RULESET_OUTCOMES)[number];

export const RULESET_INPUT_TYPES = ["text", "number", "boolean", "list", "object"] as const;
export type RulesetInputType = (typeof RULESET_INPUT_TYPES)[number];

export const MAX_RULES = 50;
export const MAX_RULESET_INPUTS = 30;
export const MAX_RULESET_TESTS = 50;
export const MAX_RULESET_LISTS = 10;
export const MAX_WHEN_LENGTH = 2000;
export const MAX_RESPONSE_BYTES = 16 * 1024;

/** One input of a ruleset. A rule reads it as `input.<name>`. */
export interface RulesetInput {
  name: string;
  type: RulesetInputType;
  required?: boolean;
  label?: string;
  description?: string;
  default?: unknown;
}

/** The rules run in order, and the first whose `when` is true gives the outcome. */
export interface RulesetRule {
  id: string;
  name: string;
  /** A CEL expression that gives true or false. */
  when: string;
  outcome: RulesetOutcome;
  /** Any JSON, given back with the outcome. */
  response?: unknown;
}

export interface RulesetTest {
  name: string;
  input: Record<string, unknown>;
  outcome: RulesetOutcome;
  /** The rule that must give the outcome. Null: no rule, so the default. Absent: any rule. */
  rule?: string | null;
}

/** What a version of a ruleset holds. Its name, description and settings are not part of it. */
export interface RulesetDefinition {
  inputs: RulesetInput[];
  rules: RulesetRule[];
  default: { outcome: RulesetOutcome; response?: unknown };
  tests: RulesetTest[];
}

export interface RulesetResult {
  /** `slug@version`, or `draft` for a definition that is not saved. */
  ruleset: string;
  outcome: RulesetOutcome;
  /** True when a rule matched, false when the default gave the outcome. */
  matched: boolean;
  rule: string | null;
  response: unknown;
  /** The list items that `inList` matched in the rule that gave the outcome. */
  terms: { list: string; item: string }[];
  /** The rules that did not run because they read an input that is not there. */
  missing: string[];
}

export const RULESET_SLUG = /^[a-z][a-z0-9_]{0,63}$/;
export const RULE_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Why a slug cannot name a ruleset, or null. `rls_…` would read as an id, and `test` is a route. */
export function rulesetSlugProblem(slug: string): string | null {
  if (!RULESET_SLUG.test(slug)) return "lower-case letters, digits and _, starting with a letter";
  if (slug.startsWith("rls_")) return 'cannot start with "rls_"';
  if (slug === "test") return 'cannot be "test"';
  return null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value ?? null)).length;

const IN_LIST = /\binList\s*\((?:[^()]|\([^()]*\))*?,\s*(?:'([^']*)'|"([^"]*)")\s*\)/g;

/** The slugs of the lists that an expression reads with `inList(value, 'slug')`. */
export function listSlugsIn(expression: string): string[] {
  return [...new Set([...expression.matchAll(IN_LIST)].map((m) => (m[1] ?? m[2])!))];
}

export function rulesetListSlugs(definition: Pick<RulesetDefinition, "rules">): string[] {
  return [...new Set(definition.rules.flatMap((r) => (typeof r.when === "string" ? listSlugsIn(r.when) : [])))];
}

function outcomeProblem(at: string, outcome: unknown): string | null {
  return RULESET_OUTCOMES.includes(outcome as RulesetOutcome) ? null : `${at}: ${RULESET_OUTCOMES.join(" or ")}`;
}

function responseProblem(at: string, response: unknown): string | null {
  return response !== undefined && jsonBytes(response) > MAX_RESPONSE_BYTES
    ? `${at}: at most ${MAX_RESPONSE_BYTES / 1024} KB of JSON`
    : null;
}

/** The problems with the shape of a ruleset definition. The server also parses each `when`. */
export function validateRuleset(definition: unknown): string[] {
  if (!isObject(definition)) return ["the ruleset must be an object with inputs, rules, default and tests"];
  const problems: string[] = [];
  const push = (p: string | null) => p && problems.push(p);

  const inputs = definition.inputs ?? [];
  if (!Array.isArray(inputs)) problems.push("inputs: must be a list");
  else {
    if (inputs.length > MAX_RULESET_INPUTS) problems.push(`inputs: at most ${MAX_RULESET_INPUTS}`);
    const names = new Set<string>();
    inputs.forEach((input: unknown, i) => {
      const at = `inputs.${isObject(input) && typeof input.name === "string" && input.name ? input.name : i}`;
      if (!isObject(input)) return problems.push(`${at}: an input is an object`);
      if (typeof input.name !== "string" || !INPUT_NAME.test(input.name))
        problems.push(`${at}.name: letters, digits and _, starting with a letter`);
      else if (names.has(input.name)) problems.push(`${at}.name: another input has this name`);
      else names.add(input.name);
      if (!RULESET_INPUT_TYPES.includes(input.type as RulesetInputType))
        problems.push(`${at}.type: ${RULESET_INPUT_TYPES.join(", ")}`);
      if (input.required !== undefined && typeof input.required !== "boolean")
        problems.push(`${at}.required: true or false`);
    });
  }

  const rules = definition.rules;
  if (!Array.isArray(rules)) problems.push("rules: must be a list");
  else {
    if (rules.length > MAX_RULES) problems.push(`rules: at most ${MAX_RULES}`);
    const ids = new Set<string>();
    const names = new Set<string>();
    rules.forEach((rule: unknown, i) => {
      const at = `rules.${isObject(rule) && typeof rule.id === "string" && rule.id ? rule.id : i}`;
      if (!isObject(rule)) return problems.push(`${at}: a rule is an object`);
      if (typeof rule.id !== "string" || !RULE_ID.test(rule.id))
        problems.push(`${at}.id: letters, digits and _, starting with a letter`);
      else if (ids.has(rule.id)) problems.push(`${at}.id: another rule has this id`);
      else ids.add(rule.id);
      if (typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 80)
        problems.push(`${at}.name: 1 to 80 characters`);
      else if (names.has(rule.name)) problems.push(`${at}.name: another rule has this name`);
      else names.add(rule.name);
      if (typeof rule.when !== "string" || !rule.when.trim()) problems.push(`${at}.when: give a condition`);
      else if (rule.when.length > MAX_WHEN_LENGTH) problems.push(`${at}.when: at most ${MAX_WHEN_LENGTH} characters`);
      push(outcomeProblem(`${at}.outcome`, rule.outcome));
      push(responseProblem(`${at}.response`, rule.response));
    });
    const lists = rulesetListSlugs({ rules: rules.filter(isObject) as unknown as RulesetRule[] });
    if (lists.length > MAX_RULESET_LISTS) problems.push(`rules: read at most ${MAX_RULESET_LISTS} lists`);
  }

  const fallback = definition.default;
  if (!isObject(fallback)) problems.push("default: give the outcome when no rule matches");
  else {
    push(outcomeProblem("default.outcome", fallback.outcome));
    push(responseProblem("default.response", fallback.response));
  }

  const tests = definition.tests ?? [];
  if (!Array.isArray(tests)) problems.push("tests: must be a list");
  else {
    if (tests.length > MAX_RULESET_TESTS) problems.push(`tests: at most ${MAX_RULESET_TESTS}`);
    const ruleIds = new Set(Array.isArray(rules) ? rules.filter(isObject).map((r) => r.id) : []);
    tests.forEach((test: unknown, i) => {
      const at = `tests.${i}`;
      if (!isObject(test)) return problems.push(`${at}: a test is an object`);
      if (typeof test.name !== "string" || !test.name.trim()) problems.push(`${at}.name: name the test`);
      if (!isObject(test.input)) problems.push(`${at}.input: must be an object`);
      push(outcomeProblem(`${at}.outcome`, test.outcome));
      if (test.rule !== undefined && test.rule !== null && !ruleIds.has(test.rule))
        problems.push(`${at}.rule: there is no rule "${String(test.rule)}"`);
    });
  }
  return problems;
}

export const MAX_LIST_ITEMS = 10_000;
export const MAX_LIST_ITEM_LENGTH = 256;
export const MAX_LIST_NOTE_LENGTH = 500;
export const LIST_SLUG = RULESET_SLUG;

export function listSlugProblem(slug: string): string | null {
  if (!LIST_SLUG.test(slug)) return "lower-case letters, digits and _, starting with a letter";
  if (slug.startsWith("lst_")) return 'cannot start with "lst_"';
  return null;
}

/** An input that `checkInputs` checks: of a ruleset, or of a manual trigger of a workflow. */
export interface CheckedInput {
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  entity?: string;
}

/** Why a value is not of an input's type, or null when it is. */
export function inputTypeProblem(input: CheckedInput, value: unknown): string | null {
  switch (input.type) {
    case "text":
      return typeof value === "string" ? null : "must be text";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "must be a number";
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "entity":
      return typeof value === "string" && value.length > 0 && value.length <= 256
        ? null
        : `must be the id of ${input.entity ? `a ${input.entity}` : "an entity"}`;
    case "list":
      return Array.isArray(value) ? null : "must be a list";
    case "object":
      return isObject(value) ? null : "must be an object";
    default:
      return "has an unknown type";
  }
}

/** Check a given input against the declared inputs, and add the defaults. Inputs that are not declared are kept. */
export function checkInputs(
  inputs: readonly CheckedInput[] | undefined,
  given: Record<string, unknown>,
): { values: Record<string, unknown>; problems: string[] } {
  const values = { ...given };
  const problems: string[] = [];
  for (const input of inputs ?? []) {
    const value = values[input.name];
    if (value === undefined || value === null || value === "") {
      if (input.default !== undefined) values[input.name] = input.default;
      else if (input.required) problems.push(`input.${input.name}: is required`);
      else delete values[input.name];
      continue;
    }
    const problem = inputTypeProblem(input, value);
    if (problem) problems.push(`input.${input.name}: ${problem}`);
  }
  return { values, problems };
}

export const LIST_MATCHES = ["exact", "prefix", "suffix", "contains", "word"] as const;
/**
 * How a value is compared with an item: it is the item, it starts or ends with it, it contains it,
 * or it contains it as a whole word ("card" is in "gift card", not in "cardholder").
 */
export type ListMatch = (typeof LIST_MATCHES)[number];

export interface ItemMatch {
  match: ListMatch;
  case_sensitive: boolean;
}

export const DEFAULT_LIST_MATCH: ItemMatch = { match: "exact", case_sensitive: false };

/** An item without `match` or `case_sensitive` uses the list's. */
export interface ListItem extends Partial<ItemMatch> {
  value: string;
  note?: string;
  added_by?: string;
  added?: string;
}

export interface ListMatcher extends ItemMatch {
  items: readonly ListItem[];
}

export const itemMatch = (list: ItemMatch, item: ListItem): ItemMatch => ({
  match: item.match ?? list.match,
  case_sensitive: item.case_sensitive ?? list.case_sensitive,
});

/** What makes two items the same on the list: their text, in lower case unless case matters. */
export const itemKey = (list: ItemMatch, item: ListItem) =>
  itemMatch(list, item).case_sensitive ? item.value : item.value.toLowerCase();

/** An item's value as the list stores it: text, trimmed. A number becomes text. Or a problem. */
export function normalizeItem(raw: unknown): { value: string } | { problem: string } {
  if (typeof raw !== "string" && typeof raw !== "number") return { problem: "must be text or a number" };
  const value = String(raw).trim();
  if (!value) return { problem: "is empty" };
  if (value.length > MAX_LIST_ITEM_LENGTH) return { problem: `at most ${MAX_LIST_ITEM_LENGTH} characters` };
  return { value };
}

const LETTER = /[\p{L}\p{N}_]/u;

function wholeWord(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
    const before = text[at - 1];
    const after = text[at + term.length];
    if ((!before || !LETTER.test(before)) && (!after || !LETTER.test(after))) return true;
  }
  return false;
}

export function itemMatches({ match, case_sensitive }: ItemMatch, item: string, value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const raw = String(value).trim();
  const text = case_sensitive ? raw : raw.toLowerCase();
  const term = case_sensitive ? item : item.toLowerCase();
  if (match === "prefix") return text.startsWith(term);
  if (match === "suffix") return text.endsWith(term);
  if (match === "contains") return text.includes(term);
  if (match === "word") return wholeWord(text, term);
  return text === term;
}

/** The first item that a value matches, each item as its own match says, or null. */
export function matchItem(list: ListMatcher, value: unknown): string | null {
  return list.items.find((item) => itemMatches(itemMatch(list, item), item.value, value))?.value ?? null;
}
