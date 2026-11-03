import type { RulesetDefinition } from "@kairos/core";
import { sql } from "drizzle-orm";
import type { RulesetRow, rulesets } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso } from "../platform/sql";
import { DefinitionVersionsService } from "./definition_version.service";

export interface RulesetView {
  id: string;
  slug: string;
  name: string;
  description?: string;
  settings: Record<string, unknown>;
  /** 0 until the first publish. */
  version: number;
  status: RulesetRow["status"];
  definition: RulesetDefinition;
  /** Saved changes that are not published. */
  draft?: RulesetDefinition;
  published_at?: string;
  created_by: string | null;
  updated_by: string | null;
  created: string;
  updated: string;
}

export const toRulesetView = (r: RulesetRow): RulesetView => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  ...(r.description ? { description: r.description } : {}),
  settings: r.settings,
  version: r.version,
  status: r.status,
  definition: r.definition,
  ...(r.draft ? { draft: r.draft } : {}),
  ...(r.publishedAt ? { published_at: iso(r.publishedAt) } : {}),
  created_by: r.createdBy,
  updated_by: r.updatedBy,
  created: iso(r.created),
  updated: iso(r.updated),
});

export const RULESET_ID = /^rls_[0-9a-hjkmnp-tv-z]{26}$/;

export class RulesetsService extends DatabaseService<"rulesets"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "rulesets", scope);
  }

  /** By its slug, or by its id when `ref` has the form of one. */
  async findRow(ref: string): Promise<RulesetRow | null> {
    return this.findFirst({ where: RULESET_ID.test(ref) ? { id: ref } : { slug: ref } });
  }

  async find(ref: string): Promise<RulesetView | null> {
    const r = await this.findRow(ref);
    return r ? toRulesetView(r) : null;
  }

  async list(
    archived: boolean,
    q: string,
    limit: number,
    offset: number,
  ): Promise<{ rulesets: RulesetView[]; total: number }> {
    const where = {
      status: archived ? ("archived" as const) : { ne: "archived" as const },
      ...(q ? { RAW: (t: typeof rulesets) => sql`strpos(lower(${t.slug} || ' ' || ${t.name}), lower(${q})) > 0` } : {}),
    };
    const [found, total] = await Promise.all([
      this.findMany({ where, orderBy: (t, { asc }) => [asc(t.name), asc(t.slug)], limit, offset }),
      this.count(where),
    ]);
    return { rulesets: found.map(toRulesetView), total };
  }

  async listLive(): Promise<RulesetView[]> {
    return (await this.findMany({ where: { status: { ne: "archived" } } })).map(toRulesetView);
  }

  async findVersion(slug: string, version: number): Promise<RulesetDefinition | null> {
    const r = await new DefinitionVersionsService(this.db, this.scope).get("ruleset", slug, version);
    return r ? (r.definition as unknown as RulesetDefinition) : null;
  }

  async listVersions(slug: string) {
    return new DefinitionVersionsService(this.db, this.scope).list("ruleset", slug);
  }
}
