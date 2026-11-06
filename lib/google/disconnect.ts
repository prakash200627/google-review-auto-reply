/**
 * Super Admin disconnect / revoke for the platform Google connection.
 * Clears local encrypted tokens; optionally revokes at Google first.
 * Never returns or logs token values. Does not delete Locations, Businesses, or Reviews.
 */

import { decryptToken } from "@/lib/crypto/tokenEncryption";
import { connectToDatabase } from "@/lib/mongodb";
import { GoogleConnection } from "@/models/GoogleConnection";
import { getOAuthEnv } from "@/lib/google/oauthConfig";

export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type DisconnectGoogleResult = {
  connectionId: string;
  orgId: string;
  previousStatus: string;
  status: "revoked";
  googleRevoked: boolean;
  googleRevokeAttempted: boolean;
  googleRevokeError: string | null;
  localTokensCleared: true;
  locationsPreserved: true;
  businessesPreserved: true;
  reviewsPreserved: true;
  message: string;
};

export class GoogleDisconnectError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "GoogleDisconnectError";
    this.code = code;
    this.status = status;
  }
}

type FetchLike = typeof fetch;

/**
 * Best-effort revoke at Google. Never throws token material.
 * Returns whether Google accepted the revoke.
 */
export async function revokeGoogleTokenAtGoogle(
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<{ ok: boolean; error: string | null }> {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return { ok: false, error: "no_token_to_revoke" };
  }

  try {
    const body = new URLSearchParams({ token: trimmed });
    const response = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (response.ok) {
      return { ok: true, error: null };
    }
    // Google often returns 400 for already-revoked tokens — treat as non-fatal.
    return {
      ok: false,
      error: `google_revoke_http_${response.status}`,
    };
  } catch {
    return { ok: false, error: "google_revoke_network_error" };
  }
}

function safeDecrypt(ciphertext: string | undefined): string | null {
  if (!ciphertext) return null;
  try {
    const plain = decryptToken(ciphertext);
    return plain || null;
  } catch {
    return null;
  }
}

/**
 * Disconnect the platform (org-level) Google connection for Super Admin.
 * Revokes at Google when possible, then clears local ciphertext and marks revoked.
 */
export async function disconnectPlatformGoogleConnection(input: {
  orgId: string;
  confirm: boolean;
  fetchImpl?: FetchLike;
}): Promise<DisconnectGoogleResult> {
  if (input.confirm !== true) {
    throw new GoogleDisconnectError(
      "Set confirm=true after acknowledging that live Google sync and publishing may stop until reconnection.",
      { code: "confirmation_required", status: 400 }
    );
  }

  const orgId = String(input.orgId || "").trim();
  if (!orgId) {
    throw new GoogleDisconnectError("Organization id is required.", {
      code: "missing_org",
      status: 400,
    });
  }

  // Ensure OAuth env is readable without throwing secrets (client id presence only).
  void getOAuthEnv();

  await connectToDatabase();

  const connection = await GoogleConnection.findOne({
    orgId,
    businessId: null,
    $or: [
      { connectionSource: "platform" },
      { connectionSource: { $exists: false } },
    ],
  })
    .select(
      "+encryptedAccessToken +encryptedRefreshToken status googleAccountEmail connectionSource"
    )
    .exec();

  if (!connection) {
    throw new GoogleDisconnectError(
      "No platform Google connection found for this organization.",
      { code: "connection_not_found", status: 404 }
    );
  }

  const previousStatus = String(connection.status || "unknown");
  const accessPlain = safeDecrypt(connection.encryptedAccessToken);
  const refreshPlain = safeDecrypt(connection.encryptedRefreshToken);

  let googleRevoked = false;
  let googleRevokeAttempted = false;
  let googleRevokeError: string | null = null;

  const fetchImpl = input.fetchImpl || fetch;
  const tokenForRevoke = refreshPlain || accessPlain;
  if (tokenForRevoke) {
    googleRevokeAttempted = true;
    const revokeResult = await revokeGoogleTokenAtGoogle(
      tokenForRevoke,
      fetchImpl
    );
    googleRevoked = revokeResult.ok;
    googleRevokeError = revokeResult.error;
  } else {
    googleRevokeError = "local_tokens_unreadable_or_empty";
  }

  // Always clear local material so tokens are not usable even if Google revoke failed.
  // updateOne without validators: schema marks token fields required, but revoked
  // rows intentionally store empty ciphertext (not usable).
  const lastError = googleRevoked
    ? "disconnected_by_super_admin"
    : googleRevokeAttempted
      ? `disconnected_local_cleared; google_revoke_failed:${googleRevokeError || "unknown"}`
      : `disconnected_local_cleared; ${googleRevokeError || "no_revoke"}`;

  await GoogleConnection.updateOne(
    { _id: connection._id },
    {
      $set: {
        encryptedAccessToken: "",
        encryptedRefreshToken: "",
        accessTokenExpiresAt: null,
        status: "revoked",
        lastError,
      },
    },
    { runValidators: false }
  );

  const message = googleRevoked
    ? "Google connection disconnected. Token revoked at Google and local credentials cleared. Locations, businesses, and reviews were preserved."
    : googleRevokeAttempted
      ? "Google connection marked revoked and local credentials cleared, but Google token revocation did not succeed. Local tokens are not usable. Reconnect when ready. Locations, businesses, and reviews were preserved."
      : "Google connection marked revoked and local credentials cleared. Could not attempt Google revocation (no usable local token). Locations, businesses, and reviews were preserved.";

  return {
    connectionId: String(connection._id),
    orgId,
    previousStatus,
    status: "revoked",
    googleRevoked,
    googleRevokeAttempted,
    googleRevokeError,
    localTokensCleared: true,
    locationsPreserved: true,
    businessesPreserved: true,
    reviewsPreserved: true,
    message,
  };
}
