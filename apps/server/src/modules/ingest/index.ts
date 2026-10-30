import { eventRoutes, type IngestDeps } from "./route";

export function ingestModule(deps: IngestDeps) {
  return { routes: eventRoutes(deps) };
}
