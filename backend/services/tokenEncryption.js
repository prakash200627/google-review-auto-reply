const crypto = require("crypto");

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

class TokenEncryptionError extends Error {
    constructor(message) {
        super(message);
        this.name = "TokenEncryptionError";
    }
}

function parseKey(raw) {
    const value = (raw || "").trim();
    if (!value) {
        throw new TokenEncryptionError("GOOGLE_TOKEN_ENCRYPTION_KEY is not configured");
    }

    let key;
    if (/^[0-9a-fA-F]{64}$/.test(value)) {
        key = Buffer.from(value, "hex");
    } else {
        try {
            key = Buffer.from(value, "base64");
        } catch {
            throw new TokenEncryptionError("GOOGLE_TOKEN_ENCRYPTION_KEY must be 32-byte hex or base64");
        }
    }

    if (key.length !== KEY_LENGTH) {
        throw new TokenEncryptionError("GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
    return key;
}

function isEncryptionConfigured(env = process.env) {
    try {
        parseKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
        return true;
    } catch {
        return false;
    }
}

function encrypt(plaintext, env = process.env) {
    if (typeof plaintext !== "string" || !plaintext) {
        throw new TokenEncryptionError("Cannot encrypt empty token");
    }
    const key = parseKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        encrypted.toString("base64url"),
    ].join(":");
}

function decrypt(payload, env = process.env) {
    if (typeof payload !== "string" || !payload) {
        throw new TokenEncryptionError("Cannot decrypt empty payload");
    }
    const parts = payload.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new TokenEncryptionError("Unrecognized encrypted token format");
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const key = parseKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    let iv;
    let tag;
    let data;
    try {
        iv = Buffer.from(ivB64, "base64url");
        tag = Buffer.from(tagB64, "base64url");
        data = Buffer.from(dataB64, "base64url");
    } catch {
        throw new TokenEncryptionError("Encrypted token payload is corrupt");
    }
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
        throw new TokenEncryptionError("Encrypted token payload is corrupt");
    }
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
        throw new TokenEncryptionError("Failed to decrypt token (wrong key or tampered data)");
    }
}

module.exports = {
    encrypt,
    decrypt,
    isEncryptionConfigured,
    TokenEncryptionError,
    VERSION,
};
