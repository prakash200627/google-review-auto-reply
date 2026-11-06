import { connectToDatabase } from "@/lib/mongodb";
import { encryptToken } from "@/lib/crypto/tokenEncryption";
import { OAuthState } from "@/models/OAuthState";
import {
  CONNECTION_SOURCES,
  GoogleConnection,
  type ConnectionSource,
} from "@/models/GoogleConnection";
import {
  BUSINESS_MANAGE_SCOPE,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GoogleOAuthError,
  OAUTH_STATE_TTL_MS,
  OPENID_SCOPES,
  assertOAuthConfigured,
  getOAuthEnv,
  validateReturnPath,
} from "@/lib/google/oauthConfig";
import {
  createOAuthState,
  createPkcePair,
  isPlausibleOAuthState,
} from "@/lib/google/pkce";

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export function buildAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: [...OPENID_SCOPES, BUSINESS_MANAGE_SCOPE].join(" "),
    state: params.state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${search.toString()}`;
}

export async function startAuthorization(input: {
  orgId: string;
  initiatedByUserId: string;
  connectionSource?: ConnectionSource;
  businessId?: string | null;
  returnPath?: unknown;
}): Promise<{ authUrl: string; expiresAt: Date }> {
  assertOAuthConfigured();
  const connectionSource: ConnectionSource =
    input.connectionSource &&
    (CONNECTION_SOURCES as readonly string[]).includes(input.connectionSource)
      ? input.connectionSource
      : "platform";

  if (connectionSource === "business_owner" && !input.businessId) {
    throw new GoogleOAuthError(
      "businessId is required for business-owner Google connections.",
      { code: "invalid_business", status: 400 }
    );
  }

  const { clientId, redirectUri } = getOAuthEnv();
  const state = createOAuthState();
  const { codeVerifier, codeChallenge } = createPkcePair();
  const safeReturn = validateReturnPath(input.returnPath);
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

  await connectToDatabase();
  await OAuthState.create({
    state,
    codeVerifier,
    orgId: input.orgId,
    connectionSource,
    businessId:
      connectionSource === "business_owner" ? input.businessId : null,
    initiatedByUserId: input.initiatedByUserId,
    returnPath: safeReturn,
    expiresAt,
  });

  return {
    authUrl: buildAuthorizationUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge,
    }),
    expiresAt,
  };
}

export async function consumeOAuthState(state: unknown): Promise<{
  orgId: string;
  codeVerifier: string;
  returnPath: string;
  connectionSource: ConnectionSource;
  businessId: string | null;
  initiatedByUserId: string;
}> {
  if (!isPlausibleOAuthState(state)) {
    throw new GoogleOAuthError("Invalid OAuth state", {
      code: "invalid_state",
      status: 400,
    });
  }

  await connectToDatabase();
  const record = await OAuthState.findOneAndUpdate(
    {
      state,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { returnDocument: "after" }
  )
    .select(
      "+codeVerifier orgId returnPath connectionSource businessId initiatedByUserId"
    )
    .lean();

  if (!record || !record.codeVerifier) {
    throw new GoogleOAuthError("OAuth state is missing, used, or expired", {
      code: "invalid_state",
      status: 400,
    });
  }

  const connectionSource: ConnectionSource =
    record.connectionSource === "business_owner"
      ? "business_owner"
      : "platform";

  return {
    orgId: String(record.orgId),
    codeVerifier: record.codeVerifier,
    returnPath: validateReturnPath(record.returnPath),
    connectionSource,
    businessId: record.businessId ? String(record.businessId) : null,
    initiatedByUserId: String(record.initiatedByUserId),
  };
}

async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
}): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret, redirectUri } = getOAuthEnv();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || data.error || !data.access_token) {
    throw new GoogleOAuthError(
      data.error_description || data.error || "Token exchange failed",
      { code: "token_exchange_failed", status: 400 }
    );
  }
  return data;
}

async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GoogleOAuthError("Failed to load Google user profile", {
      code: "userinfo_failed",
      status: 400,
    });
  }
  return (await response.json()) as GoogleUserInfo;
}

export function assertBusinessManageScope(scope: string | undefined): void {
  if (!String(scope || "").includes("business.manage")) {
    throw new GoogleOAuthError(
      "Granted scopes do not include Google Business Profile access",
      { code: "insufficient_scope", status: 400 }
    );
  }
}

export async function completeAuthorization(input: {
  code: unknown;
  state: unknown;
}): Promise<{
  orgId: string;
  returnPath: string;
  email: string;
  connectionSource: ConnectionSource;
  businessId: string | null;
}> {
  assertOAuthConfigured();

  if (typeof input.code !== "string" || !input.code.trim()) {
    throw new GoogleOAuthError("Missing authorization code", {
      code: "missing_code",
      status: 400,
    });
  }

  const consumed = await consumeOAuthState(input.state);
  if (
    consumed.connectionSource === "business_owner" &&
    !consumed.businessId
  ) {
    throw new GoogleOAuthError(
      "OAuth state is missing business binding for owner connection.",
      { code: "invalid_state", status: 400 }
    );
  }

  const tokenResponse = await exchangeAuthorizationCode({
    code: input.code.trim(),
    codeVerifier: consumed.codeVerifier,
  });

  assertBusinessManageScope(tokenResponse.scope);

  if (!tokenResponse.refresh_token) {
    throw new GoogleOAuthError(
      "No refresh token returned. Revoke prior app access and retry with consent.",
      { code: "missing_refresh_token", status: 400 }
    );
  }

  const userInfo = await fetchUserInfo(tokenResponse.access_token!);
  if (!userInfo.sub) {
    throw new GoogleOAuthError("Google user subject missing", {
      code: "missing_sub",
      status: 400,
    });
  }

  const expiresAt =
    typeof tokenResponse.expires_in === "number"
      ? new Date(Date.now() + tokenResponse.expires_in * 1000)
      : null;

  const encryptedAccessToken = encryptToken(tokenResponse.access_token!);
  const encryptedRefreshToken = encryptToken(tokenResponse.refresh_token);
  const scopes = String(tokenResponse.scope || BUSINESS_MANAGE_SCOPE)
    .split(/\s+/)
    .filter(Boolean);

  await connectToDatabase();

  // Platform upsert matches legacy org-scoped docs (businessId null) as well
  // as explicit connectionSource=platform. Owner upsert is strictly by business.
  const filter =
    consumed.connectionSource === "business_owner"
      ? {
          businessId: consumed.businessId,
          connectionSource: "business_owner" as const,
        }
      : {
          orgId: consumed.orgId,
          businessId: null,
        };

  // Tokens bind only to OAuth-state ownership — never to client-supplied ids.
  await GoogleConnection.findOneAndUpdate(
    filter,
    {
      $set: {
        orgId: consumed.orgId,
        connectionSource: consumed.connectionSource,
        businessId:
          consumed.connectionSource === "business_owner"
            ? consumed.businessId
            : null,
        connectedByUserId: consumed.initiatedByUserId,
        googleAccountEmail: userInfo.email || "",
        googleUserSub: userInfo.sub,
        encryptedAccessToken,
        encryptedRefreshToken,
        accessTokenExpiresAt: expiresAt,
        scopes,
        status: "active",
        lastError: "",
        connectedAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );

  return {
    orgId: consumed.orgId,
    returnPath: consumed.returnPath,
    email: userInfo.email || "",
    connectionSource: consumed.connectionSource,
    businessId: consumed.businessId,
  };
}

export function classifyCallbackQuery(query: {
  error?: string | string[];
  code?: string | string[];
  state?: string | string[];
}): { ok: true } | { ok: false; reason: string } {
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  if (error) {
    return { ok: false, reason: String(error) };
  }
  const code = Array.isArray(query.code) ? query.code[0] : query.code;
  const state = Array.isArray(query.state) ? query.state[0] : query.state;
  if (!code) {
    return { ok: false, reason: "missing_code" };
  }
  if (!isPlausibleOAuthState(state)) {
    return { ok: false, reason: "invalid_state" };
  }
  return { ok: true };
}
