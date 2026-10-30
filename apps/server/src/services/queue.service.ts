import type { QueueDefinition } from "@kairos/core";
import type { QueueRow } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

export class QueuesService extends DatabaseService<"queues"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "queues", scope);
  }

  list(): Promise<QueueRow[]> {
    return this.findMany({ orderBy: { created: "asc", seq: "asc" } });
  }
}

/** Who reads: a person (their user id), an API key (undefined), or a workflow, which sees every queue. */
export const SYSTEM = { system: true } as const;
export type Viewer = string | undefined | typeof SYSTEM;

export const canSee = (q: { definition: QueueDefinition; owner: string | null }, viewer: Viewer) =>
  viewer === SYSTEM || q.definition.visibility === "workspace" || (q.owner !== null && q.owner === viewer);
