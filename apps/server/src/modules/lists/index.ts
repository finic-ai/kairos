import { listRoutes, type ListsDeps } from "./route";

export { addItems, removeItems } from "./service";

export function listsModule(deps: ListsDeps) {
  return { routes: listRoutes(deps) };
}
