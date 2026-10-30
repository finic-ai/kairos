import { version } from "../../../package.json";
import type { Executor } from "../../platform/database";
import { mcpAdminRoutes, mcpRoutes, type McpDeps } from "./route";
import { createMcp } from "./service";

export function mcpModule({ db, ...deps }: Omit<McpDeps, "mcp"> & { db: Executor }) {
  const mcp = createMcp({ db, now: deps.now, version });
  return { routes: mcpRoutes({ ...deps, mcp }), adminRoutes: mcpAdminRoutes({ ...deps, mcp }) };
}
