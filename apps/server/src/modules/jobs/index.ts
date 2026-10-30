import type { SessionsService } from "../../services/session.service";
import { jobRoutes } from "./route";
import { createJobsAdmin, type JobsAdminDeps } from "./service";

export { createBackground, type Background, type BackgroundOptions } from "./service";
export type { WorkerMode } from "./types";

/** The jobs of an environment, for its admins: what waits, what failed and why, and a retry. */
export function jobsModule(deps: JobsAdminDeps & { sessions: SessionsService }) {
  return { routes: jobRoutes({ sessions: deps.sessions, admin: createJobsAdmin(deps), now: deps.now }) };
}
