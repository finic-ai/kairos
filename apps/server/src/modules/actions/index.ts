import { actionRoutes, type ActionsDeps } from "./route";

export function actionsModule(deps: ActionsDeps) {
  return { routes: actionRoutes(deps) };
}
