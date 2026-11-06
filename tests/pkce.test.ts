import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  createOAuthState,
  createPkcePair,
  isPlausibleOAuthState,
} from "@/lib/google/pkce";

describe("pkce", () => {
  it("creates S256 code_challenge from verifier", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    expect(codeVerifier.length).toBeGreaterThan(20);
    const expected = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    expect(codeChallenge).toBe(expected);
  });

  it("creates high-entropy state values", () => {
    const a = createOAuthState();
    const b = createOAuthState();
    expect(a).not.toBe(b);
    expect(isPlausibleOAuthState(a)).toBe(true);
  });

  it("rejects implausible states", () => {
    expect(isPlausibleOAuthState(null)).toBe(false);
    expect(isPlausibleOAuthState("short")).toBe(false);
    expect(isPlausibleOAuthState(123)).toBe(false);
  });
});
