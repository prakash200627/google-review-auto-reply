import { NextResponse } from "next/server";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import {
  getStoredVerificationSnapshot,
  refreshLocationVerificationStatus,
  VerificationServiceError,
} from "@/lib/google/verification";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ locationId: string }> };

/** Stored verification snapshot — Super Admin only. */
export async function GET(
  _request: Request,
  context: RouteContext
) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const org = await requireOrganizationId();
  if (!isOrgResult(org)) return org.response;

  const { locationId } = await context.params;

  try {
    const snapshot = await getStoredVerificationSnapshot(
      org.orgId,
      locationId
    );
    return NextResponse.json({ success: true, verification: snapshot });
  } catch (err) {
    return mapVerificationError(err, "Could not load verification status.");
  }
}

/**
 * Refresh verification from Google (VoiceOfMerchant + verifications.list).
 * Super Admin only. Does not start verification.
 */
export async function POST(
  request: Request,
  context: RouteContext
) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const org = await requireOrganizationId();
  if (!isOrgResult(org)) return org.response;

  const { locationId } = await context.params;

  try {
    const snapshot = await refreshLocationVerificationStatus(
      org.orgId,
      locationId
    );
    return NextResponse.json({
      success: true,
      verification: snapshot,
      refreshed: true,
    });
  } catch (err) {
    return mapVerificationError(err, "Could not refresh verification status.");
  }
}

function mapVerificationError(err: unknown, fallback: string) {
  if (
    err instanceof VerificationServiceError ||
    err instanceof GoogleBusinessApiError ||
    err instanceof GoogleOAuthError
  ) {
    return NextResponse.json(
      { success: false, code: err.code, message: err.message },
      { status: err.status }
    );
  }
  if (err instanceof TokenEncryptionError) {
    return NextResponse.json(
      {
        success: false,
        code: "token_error",
        message:
          "Stored Google credentials could not be decrypted. Reconnect Google under GMB.",
      },
      { status: 500 }
    );
  }
  console.error(
    "Verification route error:",
    err instanceof Error ? err.message : "unknown error"
  );
  return NextResponse.json(
    { success: false, code: "verification_failed", message: fallback },
    { status: 500 }
  );
}
