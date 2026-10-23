const {
    encrypt,
    decrypt,
    isEncryptionConfigured,
    TokenEncryptionError,
} = require("../services/tokenEncryption");

describe("tokenEncryption", () => {
    const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    test("encrypts and decrypts round-trip", () => {
        const env = { GOOGLE_TOKEN_ENCRYPTION_KEY: key };
        const cipher = encrypt("ya29.access-token-value", env);
        expect(cipher.startsWith("v1:")).toBe(true);
        expect(cipher).not.toContain("ya29");
        expect(decrypt(cipher, env)).toBe("ya29.access-token-value");
    });

    test("rejects missing key instead of storing plaintext", () => {
        expect(() => encrypt("secret", {})).toThrow(TokenEncryptionError);
        expect(isEncryptionConfigured({})).toBe(false);
    });

    test("rejects wrong key length", () => {
        expect(() => encrypt("secret", { GOOGLE_TOKEN_ENCRYPTION_KEY: "tooshort" })).toThrow(
            /32 bytes/
        );
    });

    test("rejects tampered ciphertext", () => {
        const env = { GOOGLE_TOKEN_ENCRYPTION_KEY: key };
        const cipher = encrypt("token", env);
        const parts = cipher.split(":");
        parts[3] = Buffer.from("tampered").toString("base64url");
        expect(() => decrypt(parts.join(":"), env)).toThrow(TokenEncryptionError);
    });

    test("accepts base64-encoded 32-byte keys", () => {
        const raw = Buffer.from(key, "hex");
        const env = { GOOGLE_TOKEN_ENCRYPTION_KEY: raw.toString("base64") };
        expect(decrypt(encrypt("abc", env), env)).toBe("abc");
    });
});
