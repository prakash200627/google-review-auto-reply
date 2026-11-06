import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { GoogleConnection } from "@/models/GoogleConnection";
import { isOAuthConfigured } from "@/lib/google/oauthConfig";

export type SafeGoogleStatus = {
  /** True only when Google OAuth env + encryption key are valid. */
  oauthConfigured: boolean;
  /**
   * Present only when a stored GoogleConnection document was found.
   * Never inferred from OAuth env alone. Never includes tokens.
   */
  connection: {
    email: string;
    status: string;
    connectedAt: string | null;
    scopes: string[];
    lastError: string;
    connectionSource: "platform" | "business_owner" | "unknown";
    businessId: string | null;
  } | null;
  /**
   * Safe user-facing message when OAuth is configured but status could not
   * be loaded (e.g. database). Never includes secrets or stack traces.
   */
  statusError: string | null;
};

const STATUS_LOAD_ERROR =
  "Could not load Google connection status. Check database connectivity and try again.";

function mapConnection(connection: {
  googleAccountEmail?: string;
  status: string;
  connectedAt?: Date | null;
  scopes?: string[];
  lastError?: string;
  connectionSource?: string;
  businessId?: mongoose.Types.ObjectId | null;
}): NonNullable<SafeGoogleStatus["connection"]> {
  const source =
    connection.connectionSource === "business_owner"
      ? "business_owner"
      : connection.connectionSource === "platform"
        ? "platform"
        : "unknown";
  return {
    email: connection.googleAccountEmail || "",
    status: connection.status,
    connectedAt: connection.connectedAt
      ? new Date(connection.connectedAt).toISOString()
      : null,
    scopes: connection.scopes || [],
    lastError: connection.lastError || "",
    connectionSource: source,
    businessId: connection.businessId ? String(connection.businessId) : null,
  };
}

/**
 * Load minimal Google connection fields for an already-authorized context.
 * Prefer a business_owner connection when businessId is provided; otherwise
 * the platform org connection. Never returns tokens or ciphertext.
 */
export async function getSafeGoogleConnectionStatus(
  orgId: string,
  options: { businessId?: string | null } = {}
): Promise<SafeGoogleStatus> {
  const oauthConfigured = isOAuthConfigured();
  if (!oauthConfigured) {
    return {
      oauthConfigured: false,
      connection: null,
      statusError: null,
    };
  }

  if (!orgId) {
    return {
      oauthConfigured: true,
      connection: null,
      statusError: null,
    };
  }

  try {
    await connectToDatabase();
    const { businessId } = options;

    if (businessId && mongoose.isValidObjectId(businessId)) {
      const ownerConn =
        (await GoogleConnection.findOne({
          orgId,
          businessId,
          connectionSource: "business_owner",
          status: { $in: ["active", "error"] },
        })
          .select(
            "googleAccountEmail status connectedAt scopes lastError connectionSource businessId"
          )
          .lean()) ||
        (await GoogleConnection.findOne({
          orgId,
          businessId,
          connectionSource: "business_owner",
          status: "revoked",
        })
          .select(
            "googleAccountEmail status connectedAt scopes lastError connectionSource businessId"
          )
          .lean());
      if (ownerConn) {
        return {
          oauthConfigured: true,
          connection: mapConnection(ownerConn),
          statusError: null,
        };
      }
    }

    // Prefer usable connections; still surface revoked so Super Admin sees exact state.
    const connection =
      (await GoogleConnection.findOne({
        orgId,
        status: { $in: ["active", "error"] },
        businessId: null,
      })
        .select(
          "googleAccountEmail status connectedAt scopes lastError connectionSource businessId"
        )
        .lean()) ||
      (await GoogleConnection.findOne({
        orgId,
        status: "revoked",
        businessId: null,
      })
        .select(
          "googleAccountEmail status connectedAt scopes lastError connectionSource businessId"
        )
        .lean());

    if (!connection) {
      return {
        oauthConfigured: true,
        connection: null,
        statusError: null,
      };
    }

    return {
      oauthConfigured: true,
      connection: mapConnection(connection),
      statusError: null,
    };
  } catch (err) {
    console.error(
      "Google connection status load failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return {
      oauthConfigured: true,
      connection: null,
      statusError: STATUS_LOAD_ERROR,
    };
  }
}

/** Exported for tests — stable copy of the safe load-failure message. */
export const GOOGLE_STATUS_LOAD_ERROR_MESSAGE = STATUS_LOAD_ERROR;
