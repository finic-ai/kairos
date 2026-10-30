import type { DashboardRow } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

export class DashboardsService extends DatabaseService<"dashboards"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "dashboards", scope);
  }

  list(): Promise<DashboardRow[]> {
    return this.findMany({ orderBy: { created: "asc", seq: "asc" } });
  }
}
