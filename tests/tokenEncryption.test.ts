import { describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  isEncryptionConfigured,
  parseEncryptionKey,
  TokenEncryptionError,
} from "@/lib/crypto/tokenEncryption";

const TEST_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("tokenEncryption", () => {
  it("parses 64-char hex keys as 32 bytes", () => {
    const key = parseEncryptionKey(TEST_KEY_HEX);
    expect(key).toHaveLength(32);
  });

  it("parses base64 keys that decode to 32 bytes", () => {
    const key = parseEncryptionKey(Buffer.alloc(32, 7).toString("base64"));
    expect(key).toHaveLength(32);
  });

  it("rejects undersized keys", () => {
    expect(() => parseEncryptionKey("abcd")).toThrow(TokenEncryptionError);
    expect(isEncryptionConfigured({ GOOGLE_TOKEN_ENCRYPTION_KEY: "" })).toBe(
      false
    );
  });

  it("round-trips encrypt/decrypt", () => {
    const env = { GOOGLE_TOKEN_ENCRYPTION_KEY: TEST_KEY_HEX };
    const ciphertext = encryptToken("refresh-token-value", env);
    expect(ciphertext.startsWith("v1:")).toBe(true);
    expect(ciphertext).not.toContain("refresh-token-value");
    expect(decryptToken(ciphertext, env)).toBe("refresh-token-value");
  });

  it("fails closed on tampered ciphertext", () => {
    const env = { GOOGLE_TOKEN_ENCRYPTION_KEY: TEST_KEY_HEX };
    const ciphertext = encryptToken("secret", env);
    const parts = ciphertext.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptToken(parts.join(":"), env)).toThrow(
      TokenEncryptionError
    );
  });
});
