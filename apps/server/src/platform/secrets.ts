import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredSecret } from "../db/schema";

/**
 * Encrypts the secrets Kairos must be able to read again: the signing secrets of webhooks.
 * AES-256-GCM with the key in KAIROS_ENCRYPTION_KEY. A hash is not enough here, because a
 * secret that signs must be known in full when it signs.
 */
export interface SecretBox {
  encrypt(secret: string, hint: string, added: string): StoredSecret;
  decrypt(stored: StoredSecret): string;
}

export function parseEncryptionKey(text: string): Buffer {
  const value = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32)
    throw new Error(
      "KAIROS_ENCRYPTION_KEY must be 32 bytes, as base64 or as 64 hexadecimal characters. Make one with: openssl rand -base64 32",
    );
  return key;
}

export function secretBox(key: Buffer): SecretBox {
  return {
    encrypt(secret, hint, added) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        hint,
        added,
      };
    },
    decrypt(stored) {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}

const SEALED = "kenc:v1:";
type FieldKeys = { cipher: Buffer; iv: Buffer };
type Master = { key: Buffer; id: string; workspaces: Map<string, FieldKeys> };
let master: Master | undefined;

/** Set once at boot, from KAIROS_ENCRYPTION_KEY. Without a key, values are kept as they are. */
export function setFieldKey(key: Buffer | undefined): void {
  master = key
    ? { key, id: createHmac("sha256", key).update("kairos key id").digest("hex").slice(0, 8), workspaces: new Map() }
    : undefined;
}

/** Keys of their own for each workspace, so that a value copied into another workspace cannot be opened there. */
function keysOf(m: Master, workspaceId: string): FieldKeys {
  let keys = m.workspaces.get(workspaceId);
  if (!keys) {
    const derive = (info: string) => Buffer.from(hkdfSync("sha256", m.key, workspaceId, info, 32));
    keys = { cipher: derive("kairos field cipher"), iv: derive("kairos field iv") };
    m.workspaces.set(workspaceId, keys);
  }
  return keys;
}

export const isSealed = (value: unknown): value is string => typeof value === "string" && value.startsWith(SEALED);

/**
 * `kenc:v1:<key id>:<iv, tag, ciphertext>`. The IV comes from the value, so that a definition that
 * did not change compares equal and makes no new version.
 */
export function sealField(value: string, workspaceId: string): string {
  if (!master || isSealed(value)) return value;
  const keys = keysOf(master, workspaceId);
  const iv = createHmac("sha256", keys.iv).update(value).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", keys.cipher, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${SEALED}${master.id}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

export function openField(value: string, workspaceId: string): string {
  if (!isSealed(value)) return value;
  if (!master) throw new Error("KAIROS_ENCRYPTION_KEY is not set, so an encrypted value cannot be read");
  const [id, payload = ""] = value.slice(SEALED.length).split(":");
  if (id !== master.id) throw new Error(`The value was encrypted with another KAIROS_ENCRYPTION_KEY (key ${id})`);
  const raw = Buffer.from(payload, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", keysOf(master, workspaceId).cipher, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/**
 * The key for one developer's embedded Postgres: made once and kept next to the data, so that
 * webhooks work with no setting. Never used with DATABASE_URL, where the key must be set.
 */
export function localEncryptionKey(file: string): Buffer {
  if (existsSync(file)) return parseEncryptionKey(readFileSync(file, "utf8"));
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600 });
  return key;
}
