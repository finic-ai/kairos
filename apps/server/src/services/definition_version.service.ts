import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso, lock } from "../platform/sql";

/** One saved version of a definition, as the API shows it. */
export interface DefinitionVersionInfo {
  version: number;
  created: string;
  created_by: string | null;
}

export class DefinitionVersionsService extends DatabaseService<"definitionVersions"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "definitionVersions", scope);
  }

  async latest(kind: string, name: string) {
    return this.findFirst({ where: { kind, name }, orderBy: { version: "desc" } });
  }

  async get(kind: string, name: string, version: number) {
    return this.findFirst({ where: { kind, name, version } });
  }

  async list(kind: string, name: string): Promise<DefinitionVersionInfo[]> {
    const rows = await this.findMany({
      where: { kind, name },
      orderBy: { version: "desc" },
      columns: { version: true, created: true, createdBy: true },
    });
    return rows.map((r) => ({ version: r.version, created: iso(r.created)!, created_by: r.createdBy }));
  }
}

/**
 * The one way to save a versioned definition: actions now, workflows later. Call it on a
 * transaction. It writes the new version to `definition_versions` and says its number; the
 * caller then points its own main row at that version, in the same transaction. A definition
 * that is the same as the current one writes nothing and keeps its version.
 */
export async function saveVersion(
  tx: Executor,
  scope: { workspaceId: string; environmentId: string },
  kind: string,
  name: string,
  definition: Record<string, unknown>,
  by: string | null,
  now: Date,
): Promise<{ version: number; changed: boolean }> {
  const versions = new DefinitionVersionsService(tx, scope);
  // One save of one name at a time, so two saves cannot both take the next version number.
  await lock(tx, kind, scope.workspaceId, scope.environmentId, name);
  const current = await versions.latest(kind, name);
  if (current && JSON.stringify(current.definition) === JSON.stringify(definition))
    return { version: current.version, changed: false };
  const version = (current?.version ?? 0) + 1;
  await versions.create({ kind, name, version, definition, createdBy: by }, now);
  return { version, changed: true };
}
