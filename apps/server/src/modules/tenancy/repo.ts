import { eq, sql } from "drizzle-orm";
import type { Executor } from "../../platform/database";
import { memberships, workspaces, type InviteRow } from "../../db/schema";
import { newId } from "../../platform/crypto";
import type { Invite, Role, User, Workspace } from "../../types";
import { iso, rows } from "../../platform/sql";
import { EnvironmentsService } from "../../services/environment.service";
import { InvitesService } from "../../services/invite.service";
import { MembershipsService } from "../../services/membership.service";
import { toWorkspace, WorkspacesService } from "../../services/workspace.service";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
export const atLeast = (role: Role | undefined, needed: Role) => role !== undefined && RANK[role] >= RANK[needed];

export const toInvite = (r: InviteRow): Invite => ({
  id: r.id,
  workspace_id: r.workspaceId,
  email: r.email,
  role: r.role,
  invited_by: r.invitedBy,
  created: iso(r.created),
  expires: iso(r.expires),
});

export type TenancyRepository = ReturnType<typeof tenancyRepository>;

export function tenancyRepository(db: Executor) {
  /** An invite that can still be used, with the name of its workspace. The token selects it, in any workspace. */
  const inviteByToken = async (token: string, now: Date): Promise<(Invite & { workspace_name: string }) | null> => {
    const r = await InvitesService.findOpenByToken(db, token, now);
    return r ? { ...toInvite(r), workspace_name: r.workspace.name } : null;
  };

  return {
    async createWorkspace(name: string, ownerId: string, now: Date): Promise<Workspace> {
      return db.transaction(async (tx) => {
        const workspace = await new WorkspacesService(tx).createWithSlug(name, now);
        await new EnvironmentsService(tx, { workspaceId: workspace.id }).create(
          { name: "Production", kind: "production" },
          now,
        );
        await new MembershipsService(tx, { workspaceId: workspace.id }).create(
          { userId: ownerId, role: "owner", status: "active" },
          now,
        );
        return workspace;
      });
    },

    /** A workspace with a fixed id and no members yet. The first person to sign up gets it. */
    async ensureWorkspace(id: string, name: string, now: Date): Promise<void> {
      await db.transaction(async (tx) => {
        const stored = new WorkspacesService(tx);
        if (await stored.findById(id, { columns: { id: true } })) return;
        await stored.createWithSlug(name, now, { id });
        await new EnvironmentsService(tx, { workspaceId: id }).create({ name: "Production", kind: "production" }, now);
      });
    },

    /** Workspaces with no members go to this user. This is how the first person to sign up gets the existing data. */
    async adoptOrphans(userId: string, now: Date): Promise<number> {
      const orphans = await rows<{ id: string }>(
        db,
        sql`SELECT id FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = w.id)`,
      );
      if (orphans.length)
        await db.insert(memberships).values(
          orphans.map((w) => ({
            id: newId("mem"),
            workspaceId: w.id,
            userId,
            role: "owner" as const,
            status: "active" as const,
            created: now,
            updated: now,
          })),
        );
      return orphans.length;
    },

    async workspacesOf(userId: string): Promise<(Workspace & { role: Role })[]> {
      const found = await db
        .select({ workspace: workspaces, role: memberships.role })
        .from(memberships)
        .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
        .where(eq(memberships.userId, userId))
        .orderBy(workspaces.created, memberships.seq);
      return found.map((w) => ({ ...toWorkspace(w.workspace), role: w.role }));
    },

    soleOwnerOf: (userId: string) =>
      rows<{ id: string; name: string; others: number }>(
        db,
        sql`SELECT w.id, w.name,
                   (SELECT COUNT(*)::int FROM memberships o WHERE o.workspace_id = w.id AND o.user_id <> m.user_id) AS others
              FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = ${userId} AND m.role = 'owner'
               AND (SELECT COUNT(*) FROM memberships o WHERE o.workspace_id = w.id AND o.role = 'owner' AND o.status = 'active') = 1`,
      ),

    inviteByToken,

    /** Adds the user to the workspace. An invite is for one address: another account cannot use it. */
    async acceptInvite(
      token: string,
      user: User,
      now: Date,
    ): Promise<{ ok: true; workspace_id: string } | { ok: false; reason: "not_found" | "wrong_email" }> {
      const invite = await inviteByToken(token, now);
      if (!invite) return { ok: false, reason: "not_found" };
      if (invite.email !== user.email) return { ok: false, reason: "wrong_email" };
      await db.transaction(async (tx) => {
        await new MembershipsService(tx, { workspaceId: invite.workspace_id }).createIfMissing(
          { userId: user.id, role: invite.role, status: "active" },
          now,
          ["userId"],
        );
        await new InvitesService(tx, { workspaceId: invite.workspace_id }).accept(invite.id, now);
      });
      return { ok: true, workspace_id: invite.workspace_id };
    },
  };
}
