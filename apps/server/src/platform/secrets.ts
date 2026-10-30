import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
