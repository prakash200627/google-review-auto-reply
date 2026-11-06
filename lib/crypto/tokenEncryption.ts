import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class TokenEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenEncryptionError";
  }
}

/**
 * Accepts either:
 * - 64 hex characters (32 bytes), or
 * - base64 that decodes to exactly 32 bytes
 *
 * Generate locally (do not commit the output):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  const value = (raw || "").trim();
  if (!value) {
    throw new TokenEncryptionError("GOOGLE_TOKEN_ENCRYPTION_KEY is not configured");
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else {
    try {
      key = Buffer.from(value, "base64");
    } catch {
      throw new TokenEncryptionError(
        "GOOGLE_TOKEN_ENCRYPTION_KEY must be 64 hex chars or base64"
      );
    }
  }

  if (key.length !== KEY_LENGTH) {
    throw new TokenEncryptionError(
      "GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes"
    );
  }
  return key;
}

type EnvLike = Record<string, string | undefined>;

export function isEncryptionConfigured(env: EnvLike = process.env): boolean {
  try {
    parseEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function encryptToken(
  plaintext: string,
  env: EnvLike = process.env
): string {
  if (typeof plaintext !== "string" || !plaintext) {
    throw new TokenEncryptionError("Cannot encrypt empty token");
  }
  const key = parseEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptToken(
  payload: string,
  env: EnvLike = process.env
): string {
  if (typeof payload !== "string" || !payload) {
    throw new TokenEncryptionError("Cannot decrypt empty payload");
  }
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenEncryptionError("Unrecognized encrypted token format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = parseEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");
  if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
    throw new TokenEncryptionError("Encrypted token metadata is invalid");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new TokenEncryptionError("Encrypted token authentication failed");
  }
}
