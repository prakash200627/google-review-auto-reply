import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  disconnectPlatformGoogleConnection,
  GoogleDisconnectError,
} from "@/lib/google/disconnect";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";

export const runtime = "nodejs";

/**
 * Super Admin only — disconnect/revoke the platform Google connection.
 * Business Admins receive 403. Does not delete Locations, Businesses, or Reviews.
 * Never returns tokens.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const actor = { actorId: auth.user.userId, actorRole: auth.user.role };

  const org = await requireOrganizationId();
  if (!isOrgResult(org)) return org.response;

  let body: { confirm?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  try {
    const result = await disconnectPlatformGoogleConnection({
      orgId: org.orgId,
      confirm: body.confirm === true,
    });

    auditLog({
      ...actor,
      action: "google.disconnect",
      success: true,
      target: {
        orgId: result.orgId,
        connectionId: result.connectionId,
        googleRevoked: result.googleRevoked,
        previousStatus: result.previousStatus,
      },
    });

    return NextResponse.json({
      success: true,
      status: result.status,
      googleRevoked: result.googleRevoked,
      googleRevokeAttempted: result.googleRevokeAttempted,
      googleRevokeError: result.googleRevokeError,
      localTokensCleared: result.localTokensCleared,
      locationsPreserved: result.locationsPreserved,
      businessesPreserved: result.businessesPreserved,
      reviewsPreserved: result.reviewsPreserved,
      message: result.message,
    });
  } catch (err) {
    if (err instanceof GoogleDisconnectError) {
      auditLog({
        ...actor,
        action: "google.disconnect",
        success: false,
        code: err.code,
      });
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
      );
    }
    auditLog({
      ...actor,
      action: "google.disconnect",
      success: false,
      code: "disconnect_failed",
    });
    console.error(
      "Google disconnect failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "disconnect_failed",
        message: "Could not disconnect Google connection.",
      },
      { status: 500 }
    );
  }
}
