import { sql } from "drizzle-orm";
import type { workspaces } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso, lock } from "../platform/sql";
import type { Workspace } from "../types";

type WorkspaceRow = typeof workspaces.$inferSelect;

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";

export const toWorkspace = (w: WorkspaceRow): Workspace => ({
  id: w.id,
  name: w.name,
  slug: w.slug,
  status: w.status,
  created: iso(w.created),
});

export class WorkspacesService extends DatabaseService<"workspaces"> {
  constructor(db: Executor) {
    super(db, "workspaces", {});
  }

  async findWorkspace(id: string): Promise<Workspace | null> {
    const r = await this.findById(id);
    return r ? toWorkspace(r) : null;
  }

  /**
   * A new workspace, with a slug of its name that no other workspace has. Run it in a
   * transaction: two workspaces made with one name at the same moment take turns.
   */
  async createWithSlug(name: string, now: Date, options: { id?: string } = {}): Promise<Workspace> {
    const base = slugOf(name);
    await lock(this.db, "workspace-slug", base);
    const taken = new Set(
      (
        await this.findMany({
          where: { OR: [{ slug: base }, { slug: { like: `${base}-%` } }] },
          columns: { slug: true },
        })
      ).map((w) => w.slug),
    );
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    return toWorkspace(await this.create({ name: name.trim(), slug, status: "active", settings: {} }, now, options));
  }

  async rename(id: string, name: string, now: Date): Promise<void> {
    await this.update(id, { name: name.trim() }, now);
  }

  /** How many days the workspace keeps its history; null (the default) keeps it forever. */
  async dataRetentionDays(id: string): Promise<number | null> {
    const days = (await this.findById(id))?.settings.data_retention_days;
    return typeof days === "number" ? days : null;
  }

  async setDataRetentionDays(id: string, days: number | null, now: Date): Promise<void> {
    if (days !== null) return this.saveSetting(id, "data_retention_days", days, now);
    await this.update(id, { settings: sql`settings - 'data_retention_days'` }, now);
  }

  async mediaHosts(id: string): Promise<string[]> {
    const hosts = (await this.findById(id))?.settings.media_hosts;
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
  }

  async setMediaHosts(id: string, hosts: string[], now: Date): Promise<void> {
    await this.saveSetting(id, "media_hosts", hosts, now);
  }

  async setting(id: string, key: string): Promise<unknown> {
    return (await this.findById(id))?.settings[key];
  }

  /** Merged in the database: a read and a write of the whole object would lose a change that another save made between them. */
  async saveSetting(id: string, key: string, value: unknown, now: Date): Promise<void> {
    await this.update(
      id,
      { settings: sql`settings || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)` },
      now,
    );
  }
}
