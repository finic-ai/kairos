import { celFunc, CelScalar, isCelError, parse, run } from "@bufbuild/cel";
import { strings } from "@bufbuild/cel/ext";
import {
  checkInputs,
  matchItem,
  validateRuleset,
  type ListMatcher,
  type RulesetDefinition,
  type RulesetResult,
  type RulesetTest,
} from "@kairos/core";

/** A rule or an input that cannot be evaluated. The same input fails again: it is not tried again. */
export class RulesetError extends Error {}

const MISSING = /^field not found: /;

/** `inList(value, 'slug')` for CEL. Each item it matches goes into `hits`. */
export function inListFunctions(lists: ReadonlyMap<string, ListMatcher>, hits: RulesetResult["terms"]) {
  const lookup = (value: unknown, slug: string) => {
    const list = lists.get(slug);
    if (!list) throw new Error(`there is no list "${slug}"`);
    const item = matchItem(list, value);
    if (item === null) return false;
    hits.push({ list: slug, item });
    return true;
  };
  return [
    celFunc("inList", [CelScalar.STRING, CelScalar.STRING], CelScalar.BOOL, lookup),
    celFunc("inList", [CelScalar.DOUBLE, CelScalar.STRING], CelScalar.BOOL, lookup),
    celFunc("inList", [CelScalar.INT, CelScalar.STRING], CelScalar.BOOL, (value, slug) => lookup(Number(value), slug)),
  ];
}

/** Null values are left out, so that a rule that reads one does not run, as for a value that is not there. */
const present = (input: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null && v !== undefined));

/**
 * Run the rules in order. The first rule whose condition is true gives the outcome; with none,
 * the default does. A rule that reads an input that is not there does not run, and is in `missing`.
 */
export function evaluateRuleset(
  ref: string,
  definition: RulesetDefinition,
  given: Record<string, unknown>,
  lists: ReadonlyMap<string, ListMatcher>,
): RulesetResult {
  const { values, problems } = checkInputs(definition.inputs, given);
  if (problems.length) throw new RulesetError(problems.join("; "));
  const input = present(values);
  const missing: string[] = [];
  for (const rule of definition.rules) {
    const terms: RulesetResult["terms"] = [];
    const result = run(rule.when, { input } as unknown as Record<string, never>, {
      funcs: [...strings, ...inListFunctions(lists, terms)],
    });
    if (isCelError(result)) {
      if (MISSING.test(result.message)) {
        missing.push(rule.id);
        continue;
      }
      throw new RulesetError(`rules.${rule.id}.when: ${result.message}`);
    }
    if (typeof result !== "boolean")
      throw new RulesetError(`rules.${rule.id}.when: gave ${JSON.stringify(String(result))}, not true or false`);
    if (result)
      return {
        ruleset: ref,
        outcome: rule.outcome,
        matched: true,
        rule: rule.id,
        response: rule.response ?? null,
        terms,
        missing,
      };
  }
  return {
    ruleset: ref,
    outcome: definition.default.outcome,
    matched: false,
    rule: null,
    response: definition.default.response ?? null,
    terms: [],
    missing,
  };
}

export interface TestResult {
  name: string;
  passed: boolean;
  result?: RulesetResult;
  error?: string;
}

export function runTest(definition: RulesetDefinition, test: RulesetTest, lists: ReadonlyMap<string, ListMatcher>) {
  try {
    const result = evaluateRuleset("draft", definition, test.input, lists);
    const passed = result.outcome === test.outcome && (test.rule === undefined || result.rule === test.rule);
    return { name: test.name, passed, result };
  } catch (cause) {
    return { name: test.name, passed: false, error: (cause as Error).message };
  }
}

const gave = (r: RulesetResult) => `${r.outcome} from ${r.rule ? `the rule "${r.rule}"` : "the default"}`;
const expected = (t: RulesetTest) =>
  `${t.outcome}${t.rule === null ? " from the default" : t.rule ? ` from the rule "${t.rule}"` : ""}`;

/**
 * Every problem that stops a publish: the shape, each condition that does not parse, a list that
 * is not there, and each test that does not give what it expects.
 */
export function publishProblems(
  definition: RulesetDefinition,
  lists: ReadonlyMap<string, ListMatcher>,
  listSlugs: readonly string[],
): string[] {
  const problems = validateRuleset(definition);
  if (problems.length) return problems;
  if (definition.rules.length === 0) problems.push("rules: add at least one rule");
  for (const rule of definition.rules) {
    try {
      parse(rule.when);
    } catch (cause) {
      problems.push(`rules.${rule.id}.when: ${(cause as Error).message}`);
    }
  }
  for (const slug of listSlugs) if (!lists.has(slug)) problems.push(`rules: there is no list "${slug}"`);
  if (problems.length) return problems;
  definition.tests.forEach((test, i) => {
    const ran = runTest(definition, test, lists);
    if (ran.error) problems.push(`tests.${i}: "${test.name}" failed: ${ran.error}`);
    else if (!ran.passed) problems.push(`tests.${i}: "${test.name}" gave ${gave(ran.result!)}, not ${expected(test)}`);
  });
  return problems;
}
