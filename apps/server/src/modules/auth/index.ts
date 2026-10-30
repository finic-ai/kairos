import { authRoutes, type AuthDeps } from "./route";

export function authModule(deps: AuthDeps) {
  return { routes: authRoutes(deps) };
}
