import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import {
  completeVerificationForLocation,
  VerificationServiceError,
} from "@/lib/google/verification";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ locationId: string }> };

/**
 * Complete a PENDING verification with the merchant PIN
 * (locations.verifications.complete). Super Admin only.
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

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, code: "invalid_json", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  if (body.confirmComplete !== true) {
    return NextResponse.json(
      {
        success: false,
        code: "confirmation_required",
        message: "Set confirmComplete=true to submit the PIN to Google.",
      },
      { status: 400 }
    );
  }

  try {
    const result = await completeVerificationForLocation(
      org.orgId,
      locationId,
      {
        pin: String(body.pin || ""),
        verificationName:
          body.verificationName !== undefined
            ? String(body.verificationName)
            : undefined,
      }
    );

    await auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "gbp.verification.complete",
      success: true,
      target: {
        orgId: org.orgId,
        locationId,
        verificationName: result.verification.name || "",
        state: result.verification.state || "",
        status: result.snapshot.verificationStatus,
      },
    });

    return NextResponse.json({
      success: true,
      verification: {
        name: result.verification.name || "",
        method: result.verification.method || "",
        state: result.verification.state || "",
      },
      status: result.snapshot,
      note: "PIN submitted. Status reflects Voice of Merchant after refresh — not a public-visibility claim.",
    });
  } catch (err) {
    if (
      err instanceof VerificationServiceError ||
      err instanceof GoogleBusinessApiError ||
      err instanceof GoogleOAuthError
    ) {
      await auditLog({
        actorId: auth.user.userId,
        actorRole: auth.user.role,
        action: "gbp.verification.complete",
        success: false,
        code: err.code,
        target: { orgId: org.orgId, locationId },
      });
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
      "Complete verification failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "complete_failed",
        message: "Could not complete Google verification.",
      },
      { status: 500 }
    );
  }
}
