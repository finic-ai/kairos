import { sql } from "drizzle-orm";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso } from "../platform/sql";
import type { EntityRef, StoredLabel } from "../types";

export class LabelsService extends DatabaseService<"labels"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "labels", scope);
  }

  /** An entity has a label once: a second one changes its time and properties. True when the label is new. */
  async save(entity: EntityRef, label: StoredLabel, now: Date): Promise<boolean> {
    const values = { ts: new Date(label.ts), properties: label.properties, metadata: label.metadata ?? {} };
    const { inserted } = await this.upsert(
      { entityType: entity.type, entityId: entity.id, label: label.label, ...values },
      now,
      ["entityType", "entityId", "label"],
      values,
    );
    return inserted;
  }

  /** The labels of one entity. With `until`, only those known at that moment: a decision as of a past moment must not see later outcomes. */
  async listFor(entity: EntityRef, until?: string): Promise<StoredLabel[]> {
    const found = await this.findMany({
      where: { entityType: entity.type, entityId: entity.id, ...(until ? { ts: { lte: new Date(until) } } : {}) },
      orderBy: (t, { asc }) => [asc(t.ts), asc(sql`${t.label} COLLATE "C"`)],
    });
    return found.map((r) => ({
      label: r.label,
      ts: iso(r.ts),
      properties: r.properties,
      ...(r.metadata && Object.keys(r.metadata).length ? { metadata: r.metadata } : {}),
    }));
  }

  async timesFor(entityType: string, ids: string[], labels: string[]): Promise<Map<string, Date[]>> {
    const out = new Map<string, Date[]>();
    if (ids.length === 0) return out;
    const found = await this.findMany({
      where: { entityType, entityId: { in: ids }, label: { in: labels } },
      columns: { entityId: true, ts: true },
    });
    for (const r of found) out.set(r.entityId, [...(out.get(r.entityId) ?? []), r.ts]);
    return out;
  }

  /** The labels of every entity, by "type/id". */
  async indexByEntity(): Promise<Map<string, Set<string>>> {
    const index = new Map<string, Set<string>>();
    for (const r of await this.findMany({ columns: { entityType: true, entityId: true, label: true } })) {
      const key = `${r.entityType}/${r.entityId}`;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key)!.add(r.label);
    }
    return index;
  }
}
