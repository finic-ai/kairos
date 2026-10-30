import { decisionRoutes, type DecisionsDeps } from "./route";

export function decisionsModule(deps: DecisionsDeps) {
  return { routes: decisionRoutes(deps) };
}
