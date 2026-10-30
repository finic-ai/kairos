import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { parseEncryptionKey } from "./secrets";
import type { CognitoConfig } from "./auth/cognito";

const flag = (on: string) =>
  z
    .string()
    .optional()
    .transform((value) => value === on);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  GRAYSON_API_KEY: z.string().min(1, "is not set"),
  /** "invite" closes sign-up to everyone without an invite. */
  KAIROS_SIGNUP: z.string().optional(),
  KAIROS_TRUST_PROXY: flag("1"),
  KAIROS_TEMPLATES: z.string().min(1).optional(),
  KAIROS_MIGRATIONS: z.string().min(1).optional(),
  KAIROS_MIGRATE_ON_START: z.enum(["0", "1"]).optional(),
  /** "separate": the API only enqueues jobs, and `worker.ts` runs them. */
  KAIROS_WORKER: z.enum(["inline", "separate"]).default("inline"),
  KAIROS_CONSOLE: z.string().min(1).optional(),
  /** Encrypts webhook signing secrets. 32 bytes, base64 or hex. */
  KAIROS_ENCRYPTION_KEY: z.string().min(1).optional(),
  /** "1" lets webhooks call private and local addresses, for development. */
  KAIROS_WEBHOOKS_ALLOW_PRIVATE: flag("1"),
  /** The bearer token of GET /internal/jobs/drain. Vercel Cron sends it when it is set in the project. */
  CRON_SECRET: z.string().min(16, "must be at least 16 characters").optional(),
  /** Days an inbound webhook payload is kept in the log. 0 keeps none. */
  KAIROS_WEBHOOK_PAYLOAD_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_PROVIDERS: z.string().optional(),
  /** Cognito sign-in: the managed login domain, the user pool, and an app client with a secret. */
  COGNITO_DOMAIN: z.string().url().optional(),
  COGNITO_ISSUER: z.string().url().optional(),
  COGNITO_CLIENT_ID: z.string().min(1).optional(),
  COGNITO_CLIENT_SECRET: z.string().min(1).optional(),
  /** Identity providers of the user pool that get a button, such as Google. */
  COGNITO_PROVIDERS: z.string().optional(),
  /** Where people open Kairos, such as https://kairos.example.com. Cognito sends them back under it. */
  KAIROS_PUBLIC_URL: z.string().url().optional(),
});

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

export interface Config {
  port: number;
  database: { url?: string; dataDir: string; port: number };
  graysonApiKey: string;
  signup: boolean;
  trustProxy: boolean;
  templatesDir: string;
  migrationsDir?: string;
  /**
   * Whether the server applies the migrations itself when it starts. Yes with the embedded
   * Postgres, which is for one developer. No with DATABASE_URL: there, `migrate` is a step of
   * the deployment, and a server that finds the database behind does not start.
   */
  migrateOnStart: boolean;
  /**
   * Where the background jobs run. "inline": in the API process. "separate": in a worker process
   * of its own (`worker.ts`), and the API only enqueues them. Both use the `jobs` table, so any
   * number of API and worker processes can share one database.
   */
  worker: "inline" | "separate";
  consoleDir?: string;
  supabase?: { url: string; anonKey: string; providers: string[] };
  /** With Cognito, people sign in only through Cognito: Kairos keeps no passwords. */
  cognito?: CognitoConfig;
  webhooks: {
    encryptionKey?: Buffer;
    /** With the embedded Postgres and no key set: where the server keeps a key it made itself. */
    localKeyFile?: string;
    allowPrivate: boolean;
    cronSecret?: string;
    payloadDays: number;
  };
}

// Next to .data/postgres, the database from before the migrations restarted, so that both use .data/encryption.key.
const DATA_DIR = fileURLToPath(new URL("../../.data/postgres2", import.meta.url));

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): Config["database"] {
  const port = Number(env.KAIROS_PG_PORT || 54329);
  if (!Number.isInteger(port) || port <= 0) throw new Error("KAIROS_PG_PORT must be a port number. See .env.example.");
  return { url: env.DATABASE_URL || undefined, dataDir: env.KAIROS_DATA_DIR || DATA_DIR, port };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value in a .env file means "not set".
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${issue.path.join(".")} ${issue.message}. See .env.example.`);
  }
  const e = parsed.data;
  const database = loadDatabaseConfig(env);
  return {
    port: e.PORT,
    database,
    graysonApiKey: e.GRAYSON_API_KEY,
    signup: e.KAIROS_SIGNUP !== "invite",
    trustProxy: e.KAIROS_TRUST_PROXY,
    templatesDir: e.KAIROS_TEMPLATES ?? fileURLToPath(new URL("../../../../templates", import.meta.url)),
    migrationsDir: e.KAIROS_MIGRATIONS,
    migrateOnStart: e.KAIROS_MIGRATE_ON_START ? e.KAIROS_MIGRATE_ON_START === "1" : !database.url,
    worker: e.KAIROS_WORKER,
    consoleDir: e.KAIROS_CONSOLE,
    webhooks: {
      // With the embedded Postgres, one developer's machine: a key is made once and kept with the data.
      encryptionKey: e.KAIROS_ENCRYPTION_KEY ? parseEncryptionKey(e.KAIROS_ENCRYPTION_KEY) : undefined,
      localKeyFile:
        e.KAIROS_ENCRYPTION_KEY || database.url ? undefined : join(database.dataDir, "..", "encryption.key"),
      allowPrivate: e.KAIROS_WEBHOOKS_ALLOW_PRIVATE,
      cronSecret: e.CRON_SECRET,
      payloadDays: e.KAIROS_WEBHOOK_PAYLOAD_DAYS,
    },
    // Supabase sign-in is offered only when both values are set.
    supabase:
      e.SUPABASE_URL && e.SUPABASE_ANON_KEY
        ? {
            url: e.SUPABASE_URL,
            anonKey: e.SUPABASE_ANON_KEY,
            providers: list(e.SUPABASE_PROVIDERS),
          }
        : undefined,
    cognito: cognitoOf(e),
  };
}

// Cognito sign-in is on when the five values are set, and a part of them is a mistake.
function cognitoOf(e: z.infer<typeof schema>): CognitoConfig | undefined {
  const values = {
    COGNITO_DOMAIN: e.COGNITO_DOMAIN,
    COGNITO_ISSUER: e.COGNITO_ISSUER,
    COGNITO_CLIENT_ID: e.COGNITO_CLIENT_ID,
    COGNITO_CLIENT_SECRET: e.COGNITO_CLIENT_SECRET,
    KAIROS_PUBLIC_URL: e.KAIROS_PUBLIC_URL,
  };
  const missing = Object.entries(values).filter(([, value]) => !value);
  if (missing.length === Object.keys(values).length) return undefined;
  if (missing.length > 0)
    throw new Error(`${missing.map(([name]) => name).join(", ")} must be set for Cognito sign-in. See .env.example.`);
  return {
    domain: e.COGNITO_DOMAIN!,
    issuer: e.COGNITO_ISSUER!,
    clientId: e.COGNITO_CLIENT_ID!,
    clientSecret: e.COGNITO_CLIENT_SECRET!,
    publicUrl: e.KAIROS_PUBLIC_URL!,
    providers: list(e.COGNITO_PROVIDERS),
  };
}
