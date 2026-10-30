import { sql } from "drizzle-orm";
import type { ApiKeyRow } from "../db/schema";
import { hashToken, newToken } from "../platform/crypto";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { apiKeys } from "../db/schema";

export interface NewApiKey {
  environmentId: string;
  name: string;
  kind: "secret" | "public";
  allowedIps: string[];
  allowedOrigins: string[];
  createdBy: string | null;
}

export type ApiKeyWithWorkspace = ApiKeyRow & { workspaceActive: boolean };

export class ApiKeysService extends DatabaseService<"apiKeys"> {
  constructor(db: Executor, scope: { workspaceId: string }) {
    super(db, "apiKeys", scope);
  }

  static async findBySecret(db: Executor, secret: string): Promise<ApiKeyWithWorkspace | null> {
    const found = await db.query.apiKeys.findFirst({
      where: { keyHash: hashToken(secret), revoked: { isNull: true } },
      with: { workspace: { columns: { status: true } } },
    });
    if (!found) return null;
    const { workspace, ...key } = found;
    return { ...key, workspaceActive: workspace.status === "active" };
  }

  async createWithSecret(input: NewApiKey, now: Date): Promise<{ key: ApiKeyRow; secret: string }> {
    const secret = `${input.kind === "public" ? "kpk" : "ksk"}_${newToken(24)}`;
    const key = await this.create(
      {
        ...input,
        name: input.name.trim(),
        keyHash: hashToken(secret),
        hint: `${secret.slice(0, 8)}…${secret.slice(-4)}`,
        allowedIps: input.allowedIps.map((ip) => ip.trim()),
      },
      now,
    );
    return { key, secret };
  }

  list(environmentId?: string): Promise<ApiKeyRow[]> {
    return this.findMany({
      where: environmentId ? { environmentId } : {},
      orderBy: (t: typeof apiKeys, { asc, desc }) => [asc(sql`${t.revoked} IS NOT NULL`), desc(t.created), asc(t.seq)],
    });
  }

  async revoke(id: string, now: Date, environmentId?: string): Promise<void> {
    await this.updateMany(
      { id, revoked: { isNull: true }, ...(environmentId ? { environmentId } : {}) },
      { revoked: now },
      now,
    );
  }

  async updateLastUsed(key: Pick<ApiKeyRow, "id" | "lastUsed">, now: Date): Promise<void> {
    if (key.lastUsed && now.getTime() - key.lastUsed.getTime() < 60_000) return;
    await this.updateActivity(key.id, { lastUsed: now });
  }
}
