import { isEncryptionConfigured } from "@/lib/crypto/tokenEncryption";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
export const BUSINESS_MANAGE_SCOPE =
  "https://www.googleapis.com/auth/business.manage";
export const OPENID_SCOPES = ["openid", "email", "profile"] as const;

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const ORG_COOKIE_NAME = "tronx_org_id";
export const ORG_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export const SAFE_RETURN_PATHS = new Set([
  "/gmb",
  "/gmb/locations",
  "/orm",
  "/orm/reviews",
  "/admin",
  "/admin/dashboard",
  // Legacy paths still accepted from in-flight OAuth states; callback remaps to /gmb.
  "/dashboard",
  "/reviews",
  "/settings/google",
]);

export class GoogleOAuthError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code = "oauth_error", status = 400 }: { code?: string; status?: number } = {}
  ) {
    super(message);
    this.name = "GoogleOAuthError";
    this.code = code;
    this.status = status;
  }
}

type EnvLike = Record<string, string | undefined>;

export function getOAuthEnv(env: EnvLike = process.env) {
  return {
    clientId: (env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: (env.GOOGLE_CLIENT_SECRET || "").trim(),
    redirectUri: (env.GOOGLE_REDIRECT_URI || "").trim(),
  };
}

export function isOAuthConfigured(env: EnvLike = process.env): boolean {
  const { clientId, clientSecret, redirectUri } = getOAuthEnv(env);
  return Boolean(
    clientId && clientSecret && redirectUri && isEncryptionConfigured(env)
  );
}

export function assertOAuthConfigured(env: EnvLike = process.env): void {
  if (!isOAuthConfigured(env)) {
    throw new GoogleOAuthError(
      "Google OAuth is not configured (client credentials, redirect URI, or encryption key missing)",
      { code: "not_configured", status: 503 }
    );
  }
}

export function validateReturnPath(returnPath: unknown): string {
  const path = typeof returnPath === "string" ? returnPath.trim() : "/gmb";
  if (!SAFE_RETURN_PATHS.has(path)) {
    return "/gmb";
  }
  return path;
}

export function appBaseUrl(env: EnvLike = process.env): string {
  const configured = (env.APP_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return "http://localhost:3000";
}
