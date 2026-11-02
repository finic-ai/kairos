import { validateHosts } from "@kairos/core";
import { invalidIpRules, normalizeOrigins } from "../../platform/network";
import { forbidden, invalid, notFound, AppError } from "../../platform/error";
import { atLeast, toInvite } from "./repo";
import type { TenancyRepository } from "../../repositories";
import type { Environments } from "../environments/service";
import type { ApiKey, KeyKind, Member, Role } from "../../types";
import type { ApiKeyRow } from "../../db/schema";
import type { Executor } from "../../platform/database";
import { ApiKeysService } from "../../services/api_key.service";
import { InvitesService } from "../../services/invite.service";
import { MembershipsService } from "../../services/membership.service";
import { nameOf, UsersService } from "../../services/user.service";
import { WorkspacesService } from "../../services/workspace.service";
import { normalizeEmail } from "../../platform/crypto";

/** A key as the API shows it: never the secret or its hash. */
const toKey = (r: ApiKeyRow): ApiKey => ({
  id: r.id,
  workspace_id: r.workspaceId,
  environment_id: r.environmentId,
  name: r.name,
  kind: r.kind,
  hint: r.hint,
  allowed_ips: r.allowedIps,
  allowed_origins: r.allowedOrigins ?? [],
  created: r.created.toISOString(),
  created_by: r.createdBy,
  last_used: r.lastUsed?.toISOString() ?? null,
  revoked: r.revoked?.toISOString() ?? null,
});

/** The website restrictions as stored, after checking both lists. */
function checkedRestrictions(kind: KeyKind, ips: string[], origins: string[]): string[] {
  const bad = invalidIpRules(ips);
  if (bad.length)
    throw invalid(`allowed_ips: "${bad[0]}" is not an IP address or an IPv4 range such as 203.0.113.0/24`);
  // Only a browser sends an Origin header that can be trusted, and only a public key belongs in a browser.
  if (kind === "secret" && origins.length)
    throw invalid("allowed_origins: only a public key can be limited to websites");
  const { origins: normalized, invalid: wrong } = normalizeOrigins(origins);
  if (wrong.length)
    throw invalid(
      `allowed_origins: "${wrong[0]}" is not a website address such as https://app.example.com or https://*.example.com`,
    );
  return normalized;
}

export function createTenancy({
  db,
  accounts,
  environments,
  now,
}: {
  db: Executor;
  accounts: TenancyRepository;
  environments: Environments;
  now: () => Date;
}) {
  const keysIn = (workspaceId: string) => new ApiKeysService(db, { workspaceId });
  const membershipsIn = (workspaceId: string, on: Executor = db) => new MembershipsService(on, { workspaceId });
  const invitesIn = (workspaceId: string, on: Executor = db) => new InvitesService(on, { workspaceId });
  const roleOf = async (workspaceId: string, userId: string) =>
    (await membershipsIn(workspaceId).findFirst({ where: { userId }, columns: { role: true } }))?.role;
  const isLastOwner = async (workspaceId: string, role: Role | undefined) =>
    role === "owner" && (await membershipsIn(workspaceId).countActiveOwners()) <= 1;
  const members = async (workspaceId: string): Promise<Member[]> =>
    (await membershipsIn(workspaceId).listWithUsers()).map(({ user: u, role, status, created }) => ({
      id: u.id,
      email: u.email,
      name: nameOf(u),
      first_name: u.firstName,
      last_name: u.lastName,
      display_name: u.displayName,
      created: u.created.toISOString(),
      role,
      status,
      joined: created.toISOString(),
    }));

  /**
   * The caller's role in the workspace, when it is at least `needed`. A workspace you are not in
   * looks the same as one that does not exist. A suspended member, or a suspended workspace, has no access.
   */
  async function requireRole(workspaceId: string, userId: string, needed: Role): Promise<Role> {
    const membership = await membershipsIn(workspaceId).findByUser(userId);
    if (!membership) throw notFound("No such workspace");
    if (!membership.active) throw forbidden("This workspace, or your membership of it, is suspended");
    if (!atLeast(membership.role, needed))
      throw forbidden(`This needs the ${needed} role. Your role is ${membership.role}.`);
    return membership.role;
  }

  const { environment } = environments;

  return {
    requireRole,

    async createWorkspace(name: string, userId: string) {
      return { ...(await accounts.createWorkspace(name, userId, now())), role: "owner" as const };
    },

    async renameWorkspace(workspaceId: string, name: string) {
      const workspaces = new WorkspacesService(db);
      await workspaces.rename(workspaceId, name, now());
      return workspaces.findWorkspace(workspaceId);
    },

    async dataRetention(workspaceId: string) {
      return { retention_days: await new WorkspacesService(db).dataRetentionDays(workspaceId) };
    },

    async setDataRetention(workspaceId: string, days: number | null) {
      await new WorkspacesService(db).setDataRetentionDays(workspaceId, days, now());
      return { retention_days: days };
    },

    async mediaHosts(workspaceId: string) {
      return { hosts: await new WorkspacesService(db).mediaHosts(workspaceId) };
    },

    async setMediaHosts(workspaceId: string, hosts: unknown) {
      const lower = Array.isArray(hosts)
        ? hosts.map((h) => (typeof h === "string" ? h.trim().toLowerCase() : h))
        : hosts;
      const problems = validateHosts(lower);
      if (problems.length) throw invalid(problems.join("; "));
      const unique = [...new Set(lower as string[])];
      await new WorkspacesService(db).setMediaHosts(workspaceId, unique, now());
      return { hosts: unique };
    },

    async deleteWorkspace(workspaceId: string, confirm: string) {
      const workspaces = new WorkspacesService(db);
      if (confirm.trim() !== (await workspaces.findWorkspace(workspaceId))!.name)
        throw new AppError("invalid", "not_confirmed", "Type the name of the workspace to confirm");
      await workspaces.delete(workspaceId);
    },

    async members(workspaceId: string, role: Role) {
      return {
        members: await members(workspaceId),
        invites: atLeast(role, "admin") ? (await invitesIn(workspaceId).listOpen(now())).map(toInvite) : [],
      };
    },

    async setRole(workspaceId: string, actorRole: Role, userId: string, role: Role) {
      const target = await roleOf(workspaceId, userId);
      if (!target) throw notFound("No such member");
      if ((target === "owner" || role === "owner") && actorRole !== "owner")
        throw forbidden("Only an owner can change an owner");
      if (role !== "owner" && (await isLastOwner(workspaceId, target)))
        throw new AppError("conflict", "last_owner", "A workspace needs at least one owner");
      await membershipsIn(workspaceId).updateMany({ userId }, { role }, now());
      return members(workspaceId);
    },

    /** The role a caller needs to remove `userId`: anyone can leave, only an admin removes someone else. */
    removalNeeds: (actorId: string, userId: string): Role => (actorId === userId ? "member" : "admin"),

    async removeMember(workspaceId: string, actorRole: Role, userId: string) {
      const target = await roleOf(workspaceId, userId);
      if (!target) throw notFound("No such member");
      if (target === "owner" && actorRole !== "owner") throw forbidden("Only an owner can remove an owner");
      if (await isLastOwner(workspaceId, target))
        throw new AppError("conflict", "last_owner", "A workspace needs at least one owner");
      await membershipsIn(workspaceId).deleteMany({ userId });
    },

    /** No email is sent: the caller gets the token and passes the link on. */
    async invite(workspaceId: string, actorRole: Role, actorId: string, email: string, role: Role) {
      if (role === "owner" && actorRole !== "owner") throw forbidden("Only an owner can invite an owner");
      const existing = await new UsersService(db).findByEmail(email);
      if (existing && (await roleOf(workspaceId, existing.id)))
        throw new AppError("conflict", "already_member", "This person is in the workspace already");
      const address = normalizeEmail(email);
      const { invite, token } = await db.transaction(async (tx) => {
        // One open invite for each address: a new one replaces the old link.
        await invitesIn(workspaceId, tx).revokeOpen(address, now());
        return invitesIn(workspaceId, tx).createWithToken({ email: address, role, invitedBy: actorId }, now());
      });
      return { invite: toInvite(invite), token };
    },

    revokeInvite: (workspaceId: string, inviteId: string) => invitesIn(workspaceId).revoke(inviteId, now()),

    async keys(workspaceId: string, environmentId: string | undefined) {
      return (await keysIn(workspaceId).list((await environment(workspaceId, environmentId)).id)).map(toKey);
    },

    async createKey(
      workspaceId: string,
      userId: string,
      input: { name: string; kind: KeyKind; allowed_ips: string[]; allowed_origins: string[]; environment_id?: string },
    ) {
      const origins = checkedRestrictions(input.kind, input.allowed_ips, input.allowed_origins);
      const target = await environment(workspaceId, input.environment_id);
      const { key, secret } = await keysIn(workspaceId).createWithSecret(
        {
          environmentId: target.id,
          name: input.name,
          kind: input.kind,
          allowedIps: input.allowed_ips,
          allowedOrigins: origins,
          createdBy: userId,
        },
        now(),
      );
      return { key: toKey(key), secret };
    },

    /** A key's name and restrictions. The secret, kind and environment never change. */
    async updateKey(
      workspaceId: string,
      environmentId: string | undefined,
      keyId: string,
      input: { name?: string; allowed_ips?: string[]; allowed_origins?: string[] },
    ) {
      const target = await environment(workspaceId, environmentId);
      const keys = keysIn(workspaceId);
      const found = await keys.findFirst({ where: { id: keyId, environmentId: target.id } });
      if (!found) throw notFound("No such API key");
      if (found.revoked) throw new AppError("conflict", "key_revoked", "A revoked key cannot be changed");
      const ips = input.allowed_ips ?? found.allowedIps;
      const origins = checkedRestrictions(found.kind, ips, input.allowed_origins ?? found.allowedOrigins ?? []);
      const updated = await keys.update(
        keyId,
        {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.allowed_ips !== undefined ? { allowedIps: ips.map((ip) => ip.trim()) } : {}),
          ...(input.allowed_origins !== undefined ? { allowedOrigins: origins } : {}),
        },
        now(),
      );
      return { before: toKey(found), key: toKey(updated!) };
    },

    async revokeKey(workspaceId: string, environmentId: string | undefined, keyId: string) {
      const target = await environment(workspaceId, environmentId);
      await keysIn(workspaceId).revoke(keyId, now(), target.id);
      return (await keysIn(workspaceId).list(target.id)).map(toKey);
    },
  };
}

export type Tenancy = ReturnType<typeof createTenancy>;
