import type { ActionDefinition } from "@kairos/core";
import { sql } from "drizzle-orm";
import type { ActionRow } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { DefinitionVersionsService } from "./definition_version.service";

/** The live row as the API shows an action: the definition, its version, and the fields that change no answer. */
const withVersion = (r: ActionRow): ActionDefinition => ({
  ...r.definition,
  ...(r.displayName ? { displayName: r.displayName } : {}),
  ...(r.automatic
    ? { automatic: true, ...(r.automaticSince ? { automaticSince: r.automaticSince.toISOString() } : {}) }
    : {}),
  version: r.version,
});

export class ActionsService extends DatabaseService<"actions"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "actions", scope);
  }

  async findLatest(name: string): Promise<ActionDefinition | null> {
    const r = await this.findFirst({ where: { name } });
    return r ? withVersion(r) : null;
  }

  async listLatest(): Promise<ActionDefinition[]> {
    const found = await this.findMany({ orderBy: (t, { asc }) => [asc(sql`${t.name} COLLATE "C"`)] });
    return found.map(withVersion);
  }

  /** One saved version of an action, current or old, from `definition_versions`. */
  async findVersion(name: string, version: number): Promise<ActionDefinition | null> {
    const r = await new DefinitionVersionsService(this.db, this.scope).get("action", name, version);
    return r ? { ...(r.definition as Omit<ActionDefinition, "version">), version: r.version } : null;
  }

  /** The versions of an action, newest first. */
  async listVersions(name: string) {
    return new DefinitionVersionsService(this.db, this.scope).list("action", name);
  }
}
