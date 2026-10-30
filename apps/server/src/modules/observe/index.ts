import { dashboardRoutes, type ObserveDeps } from "./route";

export function observeModule(deps: ObserveDeps) {
  return { routes: dashboardRoutes(deps) };
}
