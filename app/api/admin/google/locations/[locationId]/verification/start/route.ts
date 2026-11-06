import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import {
  isVerificationMethod,
  startVerificationForLocation,
  VerificationServiceError,
} from "@/lib/google/verification";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ locationId: string }> };

/**
 * Start locations.verify for an explicitly chosen method.
 * Requires confirmStart=true. Super Admin only. Never auto-started on create/sync.
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

  if (body.confirmStart !== true) {
    return NextResponse.json(
      {
        success: false,
        code: "confirmation_required",
        message:
          "Set confirmStart=true after reviewing the selected verification method.",
      },
      { status: 400 }
    );
  }

  if (!isVerificationMethod(body.method)) {
    return NextResponse.json(
      {
        success: false,
        code: "invalid_method",
        message:
          "method must be one of the VerificationMethod values returned by Google.",
      },
      { status: 400 }
    );
  }

  try {
    const result = await startVerificationForLocation(org.orgId, locationId, {
      method: body.method,
      languageCode:
        body.languageCode !== undefined
          ? String(body.languageCode)
          : undefined,
      emailAddress:
        body.emailAddress !== undefined
          ? String(body.emailAddress)
          : undefined,
      mailerContact:
        body.mailerContact !== undefined
          ? String(body.mailerContact)
          : undefined,
      phoneNumber:
        body.phoneNumber !== undefined
          ? String(body.phoneNumber)
          : undefined,
      tokenString:
        body.tokenString !== undefined
          ? String(body.tokenString)
          : undefined,
      idempotencyKey: String(body.idempotencyKey || ""),
    });

    await auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "gbp.verification.start",
      success: true,
      target: {
        orgId: org.orgId,
        locationId,
        method: body.method,
        verificationName: result.verification.name || "",
        state: result.verification.state || "",
        reusedIdempotentResult: Boolean(result.reusedIdempotentResult),
      },
    });

    return NextResponse.json({
      success: true,
      verification: {
        name: result.verification.name || "",
        method: result.verification.method || body.method,
        state: result.verification.state || "",
        createTime: result.verification.createTime || "",
      },
      status: result.snapshot,
      reusedIdempotentResult: Boolean(result.reusedIdempotentResult),
      note: "Verification was started with Google. Completing a PENDING verification may require a PIN. Voice of Merchant / public visibility are separate. verified is set only when Voice of Merchant confirms it.",
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
        action: "gbp.verification.start",
        success: false,
        code: err.code,
        target: { orgId: org.orgId, locationId, method: String(body.method || "") },
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
      "Start verification failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "start_failed",
        message: "Could not start Google verification.",
      },
      { status: 500 }
    );
  }
}
