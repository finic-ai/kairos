import { entityRoutes, type CatalogDeps } from "./route";

export function catalogModule(deps: CatalogDeps) {
  return { routes: entityRoutes(deps) };
}
