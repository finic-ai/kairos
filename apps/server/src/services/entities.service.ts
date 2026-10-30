import type { EntityDefinition } from "@kairos/core";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

/** The definitions of the entity types, in the table `entities`. The entities themselves are in `objects`. */
export class EntitiesService extends DatabaseService<"entities"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "entities", scope);
  }

  async findByType(type: string): Promise<EntityDefinition | null> {
    const r = await this.findFirst({ where: { type }, columns: { definition: true } });
    return r ? r.definition : null;
  }

  async listByTypes(types: string[]): Promise<EntityDefinition[]> {
    if (types.length === 0) return [];
    return (await this.findMany({ where: { type: { in: types } }, columns: { definition: true } })).map(
      (r) => r.definition,
    );
  }

  async save(definition: EntityDefinition, now: Date): Promise<EntityDefinition> {
    await this.upsert({ type: definition.type, definition }, now, ["type"], { definition });
    return definition;
  }
}
