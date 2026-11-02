import type { ListItem } from "@kairos/core";
import { sql } from "drizzle-orm";
import type { ListRow, lists } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso, lock } from "../platform/sql";

export interface ListView {
  id: string;
  slug: string;
  name: string;
  description?: string;
  match: ListRow["match"];
  case_sensitive: boolean;
  item_count: number;
  created_by: string | null;
  updated_by: string | null;
  created: string;
  updated: string;
}

export type ListDetail = ListView & { items: ListItem[] };

export const toListView = (r: ListRow): ListView => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  ...(r.description ? { description: r.description } : {}),
  match: r.match,
  case_sensitive: r.caseSensitive,
  item_count: r.items.length,
  created_by: r.createdBy,
  updated_by: r.updatedBy,
  created: iso(r.created),
  updated: iso(r.updated),
});

export const toListDetail = (r: ListRow): ListDetail => ({ ...toListView(r), items: r.items });

export const LIST_ID = /^lst_[0-9a-hjkmnp-tv-z]{26}$/;

export class ListsService extends DatabaseService<"lists"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "lists", scope);
  }

  /** By its slug, or by its id when `ref` has the form of one. */
  async findRow(ref: string): Promise<ListRow | null> {
    return this.findFirst({ where: LIST_ID.test(ref) ? { id: ref } : { slug: ref } });
  }

  async list(q: string, limit: number, offset: number): Promise<{ lists: ListView[]; total: number }> {
    const where = q
      ? { RAW: (t: typeof lists) => sql`strpos(lower(${t.slug} || ' ' || ${t.name}), lower(${q})) > 0` }
      : {};
    const [found, total] = await Promise.all([
      this.findMany({ where, orderBy: (t, { asc }) => [asc(t.name), asc(t.slug)], limit, offset }),
      this.count(where),
    ]);
    return { lists: found.map(toListView), total };
  }

  async bySlugs(slugs: readonly string[]): Promise<ListRow[]> {
    return slugs.length ? this.findMany({ where: { slug: { in: [...slugs] } } }) : [];
  }

  /** One change of one list at a time, so that two writes cannot both start from the same items. Call it on a transaction. */
  async lockSlug(slug: string): Promise<void> {
    await lock(this.db, "list", this.scope.workspaceId, this.scope.environmentId, slug);
  }
}
