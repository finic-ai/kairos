import { environmentRoutes, type EnvironmentsDeps } from "./route";

export function environmentsModule(deps: EnvironmentsDeps) {
  return { routes: environmentRoutes(deps) };
}
