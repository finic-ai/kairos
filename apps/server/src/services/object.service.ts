import { sql } from "drizzle-orm";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { hasValue, iso, lock, rows } from "../platform/sql";
import type { EntityRef, StoredObject } from "../types";

/** The properties of an entity in lower case, as the GIN index on objects holds them. The same text as in the schema. */
export const FOLDED = sql`(lower(o.properties::text)::jsonb)`;

/** What Kairos knows about each entity: one row for each type and customer id. */
export class ObjectsService extends DatabaseService<"objects"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "objects", scope);
  }

  async findByEntity(entity: EntityRef): Promise<StoredObject | null> {
    const r = await this.findFirst({ where: { type: entity.type, externalId: entity.id } });
    return r
      ? {
          ...entity,
          properties: r.properties,
          metadata: r.metadata,
          first_seen: iso(r.firstSeen),
          updated: iso(r.updated),
        }
      : null;
  }

  /** The entities of one type whose property has this value, compared without case. At most two: more than one is ambiguous. */
  async listIdsWithProperty(type: string, property: string, value: string): Promise<string[]> {
    // The same folded form the GIN index holds, so "CUS_N" and "cus_N" are one customer id.
    const found = await rows<{ id: string }>(
      this.db,
      sql`SELECT o.external_id AS id FROM objects o WHERE o.workspace_id = ${this.scope.workspaceId} AND o.environment_id = ${this.scope.environmentId} AND o.type = ${type} AND ${hasValue(FOLDED, property.toLowerCase(), value.toLowerCase())} ORDER BY o.external_id LIMIT 2`,
    );
    return found.map((r) => r.id);
  }

  /** Hold the row of an entity until the transaction ends. Call it on a transaction. */
  async lockEntity(entity: EntityRef): Promise<void> {
    await lock(this.db, "object", this.scope.workspaceId, this.scope.environmentId, entity.type, entity.id);
  }
}
