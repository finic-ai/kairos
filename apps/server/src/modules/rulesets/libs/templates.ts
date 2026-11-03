import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rulesetSlugProblem, validateRuleset } from "@kairos/core";
import type { RulesetTemplate } from "../types";

/** The ruleset templates in `templates/rulesets`. A file that is not a valid ruleset is left out. */
export function loadRulesetTemplates(dir: string): RulesetTemplate[] {
  try {
    return readdirSync(join(dir, "rulesets"))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(dir, "rulesets", file), "utf8")) as RulesetTemplate)
      .filter(
        (t) =>
          typeof t.slug === "string" &&
          !rulesetSlugProblem(t.slug) &&
          typeof t.name === "string" &&
          validateRuleset(t.definition).length === 0,
      );
  } catch {
    return [];
  }
}
