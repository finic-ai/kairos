import type { EnvironmentRow } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

export class EnvironmentsService extends DatabaseService<"environments"> {
  constructor(db: Executor, scope: { workspaceId: string }) {
    super(db, "environments", scope);
  }

  list(): Promise<EnvironmentRow[]> {
    return this.findMany({ orderBy: { kind: "asc", created: "asc", id: "asc" } });
  }

  /** Without an id, production: what a client that does not send an environment gets. */
  findByIdOrProduction(id?: string): Promise<EnvironmentRow | null> {
    return this.findFirst({ where: id === undefined ? { kind: "production" } : { id } });
  }
}
