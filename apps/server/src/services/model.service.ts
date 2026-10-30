import type { ModelVersionDefinition } from "@kairos/core";
import { sql } from "drizzle-orm";
import type { ModelRow, models } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso } from "../platform/sql";
import { DefinitionVersionsService } from "./definition_version.service";

export interface ModelView {
  slug: string;
  name: string;
  kind: "scoring";
  runtime: "in_process";
  status: "active" | "archived";
  version: number;
  definition: ModelVersionDefinition;
  created: string;
  updated: string;
  archived_at?: string;
}

const toModelView = (r: ModelRow): ModelView => ({
  slug: r.slug,
  name: r.name,
  kind: r.kind,
  runtime: "in_process",
  status: r.status,
  version: r.version,
  definition: r.definition,
  created: iso(r.created),
  updated: iso(r.updated),
  ...(r.archivedAt ? { archived_at: iso(r.archivedAt) } : {}),
});

export class ModelsService extends DatabaseService<"models"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "models", scope);
  }

  async findBySlug(slug: string): Promise<ModelView | null> {
    const r = await this.findFirst({ where: { slug } });
    return r ? toModelView(r) : null;
  }

  async list(q: string, limit: number, offset: number): Promise<{ models: ModelView[]; total: number }> {
    const where = q
      ? { RAW: (t: typeof models) => sql`strpos(lower(${t.slug} || ' ' || ${t.name}), lower(${q})) > 0` }
      : {};
    const [found, total] = await Promise.all([
      limit > 0 ? this.findMany({ where, orderBy: (t, { asc }) => [asc(t.slug)], limit, offset }) : [],
      this.count(where),
    ]);
    return { models: found.map(toModelView), total };
  }

  async findVersion(slug: string, version: number): Promise<ModelVersionDefinition | null> {
    const r = await new DefinitionVersionsService(this.db, this.scope).get("model", slug, version);
    return r ? (r.definition as unknown as ModelVersionDefinition) : null;
  }

  async listVersions(slug: string) {
    return new DefinitionVersionsService(this.db, this.scope).list("model", slug);
  }
}
