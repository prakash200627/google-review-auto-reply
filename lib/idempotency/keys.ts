import { createHash, randomBytes } from "crypto";

/** High-entropy idempotency key for one client attempt (URL-safe). */
export function generateIdempotencyKey(): string {
  return randomBytes(24).toString("base64url");
}

export function normalizeIdempotencyKey(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key || key.length < 16 || key.length > 128) {
    return "";
  }
  // Reject whitespace / control characters.
  if (!/^[\w.-]+$/.test(key)) {
    return "";
  }
  return key;
}

/**
 * Stable SHA-256 hex of a canonical JSON object (sorted keys, no undefined).
 */
export function hashIdempotencyPayload(
  payload: Record<string, unknown>
): string {
  const canonical = JSON.stringify(sortKeys(payload));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
