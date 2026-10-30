import { caseRoutes, type CasesDeps } from "./route";

export function casesModule(deps: CasesDeps) {
  return { routes: caseRoutes(deps) };
}
