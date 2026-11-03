import type { RulesetDefinition } from "@kairos/core";

/** A starting point for a new ruleset, from `templates/rulesets`. */
export interface RulesetTemplate {
  slug: string;
  name: string;
  /** The group the template picker shows it in, such as "Payments". */
  category?: string;
  description?: string;
  definition: RulesetDefinition;
}
