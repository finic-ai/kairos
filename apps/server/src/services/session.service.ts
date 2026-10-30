import { hashToken, newToken } from "../platform/crypto";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import type { User } from "../types";
import { toUser, UsersService } from "./user.service";

const DAY = 86_400_000;
export const SESSION_DAYS = 30;

/** Sessions in a browser. Only the hash of a token is kept: the token is returned once. */
export class SessionsService extends DatabaseService<"sessions"> {
  constructor(db: Executor) {
    super(db, "sessions", {});
  }

  /** A new session, and the user's `last_login`, in one transaction. */
  async start(userId: string, now: Date): Promise<{ token: string; expires: Date }> {
    const token = newToken();
    const expires = new Date(now.getTime() + SESSION_DAYS * DAY);
    await this.db.transaction(async (tx) => {
      await new SessionsService(tx).create({ tokenHash: hashToken(token), userId, expires }, now);
      await new UsersService(tx).updateActivity(userId, { lastLogin: now });
    });
    return { token, expires };
  }

  /** The user of a session that is still good. A disabled user's sessions are not. */
  async findUser(token: string | undefined, now: Date): Promise<User | null> {
    if (!token) return null;
    const r = await this.findFirst({
      where: { tokenHash: hashToken(token), expires: { gt: now }, user: { status: "active" } },
      with: { user: true },
    });
    return r ? toUser(r.user) : null;
  }

  async endOthers(userId: string, keepToken: string | undefined): Promise<number> {
    return (await this.deleteMany({ userId, tokenHash: { ne: keepToken ? hashToken(keepToken) : "" } })).length;
  }

  async end(token: string): Promise<void> {
    await this.deleteMany({ tokenHash: hashToken(token) });
  }
}
