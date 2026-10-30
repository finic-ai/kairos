import type { Executor } from "../../platform/database";
import { ActivitiesService, type ActivityWithUser } from "../../services/activity.service";
import { nameOf } from "../../services/user.service";
import type { Role } from "../../types";
import type { ActivityQuery } from "./schema";
import type { ActivityPage, ActivityView } from "./types";

const toView = (r: ActivityWithUser): ActivityView => ({
  id: r.id,
  action: r.action,
  resource_type: r.resourceType,
  resource_id: r.resourceId,
  details: r.details,
  environment_id: r.environmentId,
  source: r.source,
  user: r.user ? { id: r.user.id, name: nameOf(r.user), email: r.user.email } : null,
  created: r.created.toISOString(),
});

/** A date with no time is a whole day: `to` then means the end of it. */
const moment = (value: string, end: boolean) => {
  if (value.includes("T")) return new Date(value);
  const day = new Date(`${value}T00:00:00Z`);
  return end ? new Date(day.getTime() + 86_400_000) : day;
};

export function createActivities({
  db,
  requireRole,
}: {
  db: Executor;
  requireRole: (workspaceId: string, userId: string, needed: Role) => Promise<Role>;
}) {
  return {
    /** A member sees only their own activity. An admin or an owner sees everyone's, and can choose one person. */
    async list(workspaceId: string, viewerId: string, query: ActivityQuery): Promise<ActivityPage> {
      const role = await requireRole(workspaceId, viewerId, "member");
      const userId = role === "member" ? viewerId : query.user;
      const found = await new ActivitiesService(db, { workspaceId }).list({
        ...(userId ? { userId } : {}),
        ...(query.resource ? { resource: { type: query.resource } } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.from ? { from: moment(query.from, false) } : {}),
        ...(query.to ? { to: moment(query.to, true) } : {}),
        ...(query.after ? { after: query.after } : {}),
        limit: query.limit,
      });
      return {
        activities: found.map(toView),
        next: found.length === query.limit ? found[found.length - 1]!.id : null,
      };
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
