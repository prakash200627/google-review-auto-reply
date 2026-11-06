import { describe, expect, it } from "vitest";
import {
  assertBusinessManageScope,
  buildAuthorizationUrl,
  classifyCallbackQuery,
} from "@/lib/google/oauth";
import {
  GoogleOAuthError,
  isOAuthConfigured,
  validateReturnPath,
} from "@/lib/google/oauthConfig";

describe("oauth helpers", () => {
  it("validateReturnPath allowlists safe paths", () => {
    expect(validateReturnPath("/gmb")).toBe("/gmb");
    expect(validateReturnPath("/orm/reviews")).toBe("/orm/reviews");
    expect(validateReturnPath("/settings/google")).toBe("/settings/google");
    expect(validateReturnPath("/dashboard")).toBe("/dashboard");
    expect(validateReturnPath("https://evil.example")).toBe("/gmb");
    expect(validateReturnPath("/gmb?x=1")).toBe("/gmb");
  });

  it("classifyCallbackQuery handles Google errors and missing fields", () => {
    expect(classifyCallbackQuery({ error: "access_denied" })).toEqual({
      ok: false,
      reason: "access_denied",
    });
    expect(classifyCallbackQuery({ state: "abcdefghijklmnop" })).toEqual({
      ok: false,
      reason: "missing_code",
    });
    expect(
      classifyCallbackQuery({
        code: "auth-code",
        state: "abcdefghijklmnop",
      })
    ).toEqual({ ok: true });
  });

  it("assertBusinessManageScope requires business.manage", () => {
    expect(() => assertBusinessManageScope("openid email")).toThrow(
      GoogleOAuthError
    );
    expect(() =>
      assertBusinessManageScope(
        "openid email https://www.googleapis.com/auth/business.manage"
      )
    ).not.toThrow();
  });

  it("buildAuthorizationUrl includes PKCE and offline access", () => {
    const url = buildAuthorizationUrl({
      clientId: "client",
      redirectUri: "http://localhost:3000/api/auth/google/callback",
      state: "state-value-123456",
      codeChallenge: "challenge",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/google/callback"
    );
    expect(parsed.searchParams.get("scope")).toContain("business.manage");
    expect(parsed.searchParams.get("scope")).toContain("openid");
  });

  it("isOAuthConfigured requires encryption key and client credentials", () => {
    expect(
      isOAuthConfigured({
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/google/callback",
        GOOGLE_TOKEN_ENCRYPTION_KEY:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      })
    ).toBe(true);

    expect(
      isOAuthConfigured({
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/google/callback",
      })
    ).toBe(false);
  });
});
