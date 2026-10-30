import type { InviteRow } from "../db/schema";
import { hashToken, newToken } from "../platform/crypto";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

const DAY = 86_400_000;
export const INVITE_DAYS = 7;

const open = (now: Date) => ({ accepted: { isNull: true }, revoked: { isNull: true }, expires: { gt: now } }) as const;

export interface NewInvite {
  email: string;
  role: InviteRow["role"];
  invitedBy: string;
}

export class InvitesService extends DatabaseService<"invites"> {
  constructor(db: Executor, scope: { workspaceId: string }) {
    super(db, "invites", scope);
  }

  /** The token selects the invite, in any workspace. */
  static async findOpenByToken(db: Executor, token: string, now: Date) {
    return (
      (await db.query.invites.findFirst({
        where: { tokenHash: hashToken(token), ...open(now) },
        with: { workspace: { columns: { name: true } } },
      })) ?? null
    );
  }

  /** The token is returned once: only its hash is kept. Run it in a transaction with `revokeOpen` for the address. */
  async createWithToken(input: NewInvite, now: Date): Promise<{ invite: InviteRow; token: string }> {
    const token = newToken(24);
    const invite = await this.create(
      { ...input, tokenHash: hashToken(token), expires: new Date(now.getTime() + INVITE_DAYS * DAY) },
      now,
    );
    return { invite, token };
  }

  listOpen(now: Date): Promise<InviteRow[]> {
    return this.findMany({ where: open(now), orderBy: { created: "desc" } });
  }

  async revokeOpen(email: string, now: Date): Promise<void> {
    await this.updateMany({ email, accepted: { isNull: true }, revoked: { isNull: true } }, { revoked: now }, now);
  }

  async revoke(id: string, now: Date): Promise<void> {
    await this.updateMany({ id, accepted: { isNull: true } }, { revoked: now }, now);
  }

  async accept(id: string, now: Date): Promise<void> {
    await this.updateMany({ id }, { accepted: now }, now);
  }
}
