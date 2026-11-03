import { rulesetRoutes, type RulesetsDeps } from "./route";

export { loadRulesetTemplates } from "./libs";
export { describeRuleset, evaluateRef, loadLists, parseRulesetRef } from "./service";
export type { RulesetTemplate } from "./types";

export function rulesetsModule(deps: RulesetsDeps) {
  return { routes: rulesetRoutes(deps) };
}
