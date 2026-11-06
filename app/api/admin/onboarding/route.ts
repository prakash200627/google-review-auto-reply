import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  completeBusinessOnboarding,
  OnboardingError,
} from "@/lib/business/onboarding";

export const runtime = "nodejs";

/**
 * Super Admin only — confirm business + group + Google location onboarding.
 * Never infers relationships from name/address. Business Admins are denied.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, code: "invalid_json", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  try {
    const result = await completeBusinessOnboarding({
      confirm: body.confirm === true,
      name: String(body.name || ""),
      locationId: String(body.locationId || ""),
      groupId: String(body.groupId || ""),
      idempotencyKey: String(body.idempotencyKey || ""),
      confirmReassign: body.confirmReassign === true,
      replyMode:
        body.replyMode !== undefined ? String(body.replyMode) : undefined,
      brandVoice:
        body.brandVoice !== undefined ? String(body.brandVoice) : undefined,
      preferredLanguage:
        body.preferredLanguage !== undefined
          ? String(body.preferredLanguage)
          : undefined,
      planCode:
        body.planCode !== undefined ? String(body.planCode) : undefined,
    });

    await auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "business.onboarding.complete",
      success: true,
      target: {
        businessId: result.business.id,
        groupId: result.group?.id || "",
        locationId: result.location.id,
        reassignedFrom: result.reassignedFrom?.businessId || "",
        reusedIdempotentResult: Boolean(result.reusedIdempotentResult),
      },
    });

    return NextResponse.json({
      success: true,
      ...result,
      note: "Assignment is explicit. Verification status was not changed by onboarding.",
    });
  } catch (err) {
    if (err instanceof OnboardingError) {
      await auditLog({
        actorId: auth.user.userId,
        actorRole: auth.user.role,
        action: "business.onboarding.complete",
        success: false,
        code: err.code,
        target: {
          locationId: String(body.locationId || ""),
          groupId: String(body.groupId || ""),
        },
      });
      return NextResponse.json(
        {
          success: false,
          code: err.code,
          message: err.message,
          conflict: err.conflict || undefined,
        },
        { status: err.status }
      );
    }
    console.error(
      "Onboarding failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "onboarding_failed",
        message: "Could not complete business onboarding.",
      },
      { status: 500 }
    );
  }
}
