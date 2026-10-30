import { sql } from "drizzle-orm";
import type { activities, ActivityRow, ActivitySource, users } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService, type Filter } from "../platform/orm";

export interface NewActivity {
  environmentId: string | null;
  source: ActivitySource;
  userId: string | null;
  apiKeyId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ActivityFilter {
  environmentId?: string;
  userId?: string;
  resource?: { type: string; id?: string };
  /** Found in the action, the resource, the details, or the person's name or email address. */
  q?: string;
  from?: Date;
  to?: Date;
  /** The next page: the activities after this one, in the order of the list. */
  after?: string;
  limit?: number;
}

const PERSON = { id: true, email: true, firstName: true, lastName: true, displayName: true } as const;

export type ActivityWithUser = ActivityRow & {
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    displayName: string | null;
  } | null;
};

export class ActivitiesService extends DatabaseService<"activities"> {
  constructor(db: Executor, scope: { workspaceId: string }) {
    super(db, "activities", scope);
  }

  record(input: NewActivity, now: Date): Promise<ActivityRow> {
    return this.create({ ...input, details: input.details ?? {} }, now);
  }

  /** The newest first. */
  async list(filter: ActivityFilter = {}): Promise<ActivityWithUser[]> {
    const last = filter.after ? await this.findById(filter.after, { columns: { id: true, created: true } }) : null;
    const q = filter.q?.trim();
    const and = [
      ...(last ? [{ OR: [{ created: { lt: last.created } }, { created: last.created, id: { lt: last.id } }] }] : []),
      ...(q
        ? [
            {
              OR: [
                {
                  // "api_key.created" is found as "api key created".
                  RAW: (t: typeof activities) =>
                    sql`strpos(lower(translate(${t.action}, '._', '  ') || ' ' || coalesce(${t.resourceId}, '') || ' ' || ${t.details}::text), lower(${q})) > 0`,
                },
                {
                  user: {
                    RAW: (u: typeof users) =>
                      sql`strpos(lower(coalesce(${u.displayName}, '') || ' ' || coalesce(${u.firstName}, '') || ' ' || coalesce(${u.lastName}, '') || ' ' || ${u.email}), lower(${q})) > 0`,
                  },
                },
              ],
            },
          ]
        : []),
    ];
    const where = {
      ...(filter.environmentId ? { environmentId: filter.environmentId } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.resource ? { resourceType: filter.resource.type } : {}),
      ...(filter.resource?.id ? { resourceId: filter.resource.id } : {}),
      ...(filter.from || filter.to
        ? { created: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) } }
        : {}),
      ...(and.length ? { AND: and } : {}),
    } as Filter<"activities">;
    return this.findMany({
      where,
      with: { user: { columns: PERSON } },
      orderBy: { created: "desc", id: "desc" },
      limit: filter.limit ?? 50,
    }) as Promise<ActivityWithUser[]>;
  }
}
