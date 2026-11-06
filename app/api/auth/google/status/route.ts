import { NextResponse } from "next/server";
import {
  isOrgUserResult,
  requireOrgAndUserAccess,
} from "@/lib/auth/googleRouteAuth";
import {
  getSafeGoogleConnectionStatus,
  GOOGLE_STATUS_LOAD_ERROR_MESSAGE,
} from "@/lib/google/connectionStatus";
import { isOAuthConfigured } from "@/lib/google/oauthConfig";

export const runtime = "nodejs";

/**
 * Safe connection status for the caller's authorized organization.
 * Requires a signed-in user with org access. Never returns tokens.
 */
export async function GET() {
  const gate = await requireOrgAndUserAccess();
  if (!isOrgUserResult(gate)) {
    return gate.response;
  }

  try {
    const status = await getSafeGoogleConnectionStatus(gate.orgId);
    return NextResponse.json({
      success: !status.statusError,
      oauthConfigured: status.oauthConfigured,
      connection: status.connection,
      statusError: status.statusError,
      ...(status.statusError ? { message: status.statusError } : {}),
    });
  } catch (err) {
    console.error(
      "OAuth status failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        oauthConfigured: isOAuthConfigured(),
        connection: null,
        statusError: GOOGLE_STATUS_LOAD_ERROR_MESSAGE,
        message: GOOGLE_STATUS_LOAD_ERROR_MESSAGE,
      },
      { status: 500 }
    );
  }
}
