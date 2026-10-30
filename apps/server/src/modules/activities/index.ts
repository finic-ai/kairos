import type { Executor } from "../../platform/database";
import type { SessionsService } from "../../services/session.service";
import type { Role } from "../../types";
import { activityRoutes } from "./route";
import { createActivities } from "./service";

/** What people did in a workspace. Each change records itself with `c.var.logActivity` (platform/activity.ts). */
export function activitiesModule({
  db,
  sessions,
  requireRole,
  now,
}: {
  db: Executor;
  sessions: SessionsService;
  requireRole: (workspaceId: string, userId: string, needed: Role) => Promise<Role>;
  now: () => Date;
}) {
  return { routes: activityRoutes({ sessions, activities: createActivities({ db, requireRole }), now }) };
}
