import { sql, type SQLWrapper } from "drizzle-orm";
import type { users } from "../db/schema";
import { normalizeEmail, verifyPassword } from "../platform/crypto";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso } from "../platform/sql";
import type { Auth, Provider, Strategy, User } from "../types";

type UserRow = typeof users.$inferSelect;

export const nameOf = (r: {
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
}) => r.displayName || [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email.split("@")[0]!;

/** A person as the API shows them: never how they sign in. */
export const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: nameOf(r),
  first_name: r.firstName,
  last_name: r.lastName,
  display_name: r.displayName,
  created: iso(r.created),
});

export interface NewUser {
  email: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  auth: Auth;
  passwordHash?: string;
  subjectId?: string;
}

const providerIs = (auth: SQLWrapper, provider: Provider) => sql`${auth} ->> 'provider' = ${provider}`;

/**
 * People, and how they sign in. Only this service reads `auth`, `subject_id` and `password_hash`:
 * the routes ask it questions ("is this the password?") instead. So a later table of identities,
 * with more than one way to sign in for a person, changes only this file.
 */
export class UsersService extends DatabaseService<"users"> {
  constructor(db: Executor) {
    super(db, "users", {});
  }

  /** Writes `password_hash` for a native user and `subject_id` for a Supabase or Cognito one, never both. */
  async createWithAuth(input: NewUser, now: Date): Promise<User> {
    if (input.auth.provider === "native" && (!input.passwordHash || input.subjectId))
      throw new Error("A native user has a password and no subject id");
    if (input.auth.provider !== "native" && (!input.subjectId || input.passwordHash))
      throw new Error("A Supabase or Cognito user has a subject id and no password");
    const blank = (v: string | null | undefined) => v?.trim() || null;
    const r = await this.create(
      {
        email: normalizeEmail(input.email),
        firstName: blank(input.firstName),
        lastName: blank(input.lastName),
        displayName: blank(input.displayName),
        status: "active",
        auth: input.auth,
        settings: {},
        passwordHash: input.auth.provider === "native" ? input.passwordHash! : null,
        subjectId: input.auth.provider !== "native" ? input.subjectId! : null,
      },
      now,
    );
    return toUser(r);
  }

  async findByEmail(email: string): Promise<User | null> {
    const r = await this.findFirst({ where: { email: normalizeEmail(email) } });
    return r ? toUser(r) : null;
  }

  async findByIdentity(
    provider: Exclude<Provider, "native">,
    subject: string,
  ): Promise<(User & { disabled: boolean }) | null> {
    const r = await this.findFirst({ where: { subjectId: subject, RAW: (t) => providerIs(t.auth, provider) } });
    return r ? { ...toUser(r), disabled: r.status !== "active" } : null;
  }

  async setStrategy(
    userId: string,
    provider: Exclude<Provider, "native">,
    strategy: Strategy | undefined,
    now: Date,
  ): Promise<void> {
    await this.updateMany(
      { id: userId, RAW: (t) => providerIs(t.auth, provider) },
      { auth: { provider, strategy } },
      now,
    );
  }

  /**
   * The native, active user with this email and this password. Null otherwise: an unknown
   * address, a wrong password, a Supabase user and a disabled one all look the same.
   */
  async signInWithPassword(email: string, password: string): Promise<User | null> {
    const r = await this.findFirst({ where: { email: normalizeEmail(email), status: "active" } });
    if (!r || (r.auth as Auth).provider !== "native" || !(await verifyPassword(password, r.passwordHash))) return null;
    return toUser(r);
  }

  /** The Cognito user of a person who signs in with Cognito, and how they sign in there. */
  async cognitoIdentityOf(userId: string): Promise<{ subject: string; strategy?: Strategy } | null> {
    const r = await this.findById(userId, { columns: { auth: true, subjectId: true } });
    const auth = r?.auth as Auth | undefined;
    return auth?.provider === "cognito" && r!.subjectId ? { subject: r!.subjectId, strategy: auth.strategy } : null;
  }

  async providerOf(userId: string): Promise<Provider> {
    const r = await this.findById(userId, { columns: { auth: true } });
    return (r!.auth as Auth).provider;
  }

  async checkPassword(userId: string, password: string): Promise<boolean> {
    const r = await this.findById(userId, { columns: { auth: true, passwordHash: true } });
    return !!r && (r.auth as Auth).provider === "native" && verifyPassword(password, r.passwordHash);
  }

  async setPassword(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.updateMany({ id: userId, RAW: (t) => providerIs(t.auth, "native") }, { passwordHash }, now);
  }

  async rename(userId: string, name: string, now: Date): Promise<void> {
    await this.update(userId, { displayName: name.trim() || null }, now);
  }
}
