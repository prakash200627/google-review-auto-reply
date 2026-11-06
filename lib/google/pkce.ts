import { createHash, randomBytes } from "crypto";

export function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

export function createOAuthState(): string {
  return base64Url(randomBytes(32));
}

/** Constant-time-ish length check; full validation is DB single-use + expiry. */
export function isPlausibleOAuthState(state: unknown): state is string {
  return typeof state === "string" && state.length >= 16 && state.length <= 128;
}
