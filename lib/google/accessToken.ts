import mongoose from "mongoose";
import { decryptToken, encryptToken } from "@/lib/crypto/tokenEncryption";
import { connectToDatabase } from "@/lib/mongodb";
import { GoogleConnection } from "@/models/GoogleConnection";
import {
  getOAuthEnv,
  GOOGLE_TOKEN_URL,
  GoogleOAuthError,
} from "@/lib/google/oauthConfig";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";

/** Refresh a minute before expiry to avoid edge races. */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

type FetchLike = typeof fetch;

interface TokenRefreshResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

type ConnectionLean = {
  _id: mongoose.Types.ObjectId;
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  accessTokenExpiresAt?: Date | null;
  status?: string;
  connectionSource?: string;
  businessId?: mongoose.Types.ObjectId | null;
};

export function accessTokenNeedsRefresh(
  expiresAt: Date | null | undefined,
  now: number = Date.now()
): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() <= now + ACCESS_TOKEN_EXPIRY_SKEW_MS;
}

async function refreshGoogleAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike
): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }> {
  const { clientId, clientSecret } = getOAuthEnv();
  if (!clientId || !clientSecret) {
    throw new GoogleOAuthError("Google OAuth is not configured", {
      code: "not_configured",
      status: 503,
    });
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = (await response.json()) as TokenRefreshResponse;
  if (!response.ok || data.error || !data.access_token) {
    throw new GoogleBusinessApiError(
      "Google rejected the refresh token. Reconnect Google under Settings.",
      {
        code: "refresh_failed",
        status: 401,
        googleStatus: data.error || "",
      }
    );
  }

  const expiresAt =
    typeof data.expires_in === "number"
      ? new Date(Date.now() + data.expires_in * 1000)
      : new Date(Date.now() + 3500 * 1000);

  return {
    accessToken: data.access_token,
    expiresAt,
    refreshToken: data.refresh_token,
  };
}

/**
 * Resolve the authorized Google connection for an operation.
 * Prefer a business_owner connection for the given businessId; otherwise use
 * the platform org connection. Never returns another business's tokens.
 */
export async function findActiveGoogleConnection(input: {
  orgId: string;
  businessId?: string | null;
}): Promise<ConnectionLean | null> {
  const { orgId, businessId } = input;
  if (!mongoose.isValidObjectId(orgId)) return null;

  await connectToDatabase();

  if (businessId && mongoose.isValidObjectId(businessId)) {
    const ownerConn = await GoogleConnection.findOne({
      businessId,
      connectionSource: "business_owner",
      status: "active",
      orgId,
    })
      .select(
        "+encryptedAccessToken +encryptedRefreshToken accessTokenExpiresAt status connectionSource businessId"
      )
      .lean<ConnectionLean | null>();
    if (ownerConn) return ownerConn;
  }

  // Platform-managed (and legacy docs without connectionSource).
  return GoogleConnection.findOne({
    orgId,
    status: "active",
    $or: [
      { connectionSource: "platform" },
      { connectionSource: { $exists: false } },
      { businessId: null },
    ],
    // Exclude another business's owner tokens if they share the org.
    businessId: null,
  })
    .select(
      "+encryptedAccessToken +encryptedRefreshToken accessTokenExpiresAt status connectionSource businessId"
    )
    .lean<ConnectionLean | null>();
}

async function materializeAccessToken(
  connection: ConnectionLean,
  fetchImpl: FetchLike
): Promise<string> {
  const encryptedAccess = connection.encryptedAccessToken;
  const encryptedRefresh = connection.encryptedRefreshToken;
  if (!encryptedAccess || !encryptedRefresh) {
    throw new GoogleBusinessApiError(
      "Stored Google credentials are incomplete. Reconnect Google under Settings.",
      { code: "not_connected", status: 401 }
    );
  }

  let accessToken = decryptToken(encryptedAccess);
  const refreshToken = decryptToken(encryptedRefresh);

  if (!accessTokenNeedsRefresh(connection.accessTokenExpiresAt)) {
    return accessToken;
  }

  try {
    const refreshed = await refreshGoogleAccessToken(refreshToken, fetchImpl);
    accessToken = refreshed.accessToken;

    const update: Record<string, unknown> = {
      encryptedAccessToken: encryptToken(refreshed.accessToken),
      accessTokenExpiresAt: refreshed.expiresAt,
      lastError: "",
      status: "active",
    };
    if (refreshed.refreshToken) {
      update.encryptedRefreshToken = encryptToken(refreshed.refreshToken);
    }

    await GoogleConnection.updateOne({ _id: connection._id }, { $set: update });
    return accessToken;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to refresh Google access token";
    await GoogleConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          status: "error",
          lastError: "token_refresh_failed",
        },
      }
    );
    if (err instanceof GoogleBusinessApiError || err instanceof GoogleOAuthError) {
      throw err;
    }
    throw new GoogleBusinessApiError(message, {
      code: "refresh_failed",
      status: 401,
    });
  }
}

/**
 * Access token for Super Admin location discovery (platform org connection).
 */
export async function getValidAccessTokenForOrg(
  orgId: string,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const connection = await findActiveGoogleConnection({ orgId, businessId: null });
  if (!connection) {
    throw new GoogleBusinessApiError(
      "No active Google connection for this organization. Connect Google first.",
      { code: "not_connected", status: 401 }
    );
  }
  return materializeAccessToken(connection, fetchImpl);
}

/**
 * Access token for business-scoped Google API work (sync/publish).
 * Uses the owner connection when present; otherwise the platform connection.
 */
export async function getValidAccessTokenForContext(
  input: { orgId: string; businessId?: string | null },
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const connection = await findActiveGoogleConnection(input);
  if (!connection) {
    throw new GoogleBusinessApiError(
      "No active Google connection for this business or organization. Connect Google first.",
      { code: "not_connected", status: 401 }
    );
  }
  // Defense in depth: owner tokens must match the requested business.
  if (
    connection.connectionSource === "business_owner" &&
    input.businessId &&
    String(connection.businessId || "") !== String(input.businessId)
  ) {
    throw new GoogleBusinessApiError(
      "Google connection does not belong to this business.",
      { code: "forbidden", status: 403 }
    );
  }
  return materializeAccessToken(connection, fetchImpl);
}
