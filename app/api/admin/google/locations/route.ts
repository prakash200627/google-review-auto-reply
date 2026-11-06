import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  createGbpLocationForOrg,
  CreateGbpLocationError,
} from "@/lib/google/createLocation";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";

export const runtime = "nodejs";

/**
 * Create a Google Business Profile location under an explicitly selected account.
 * Super Admin only. Does not assign to a business/group. Does not verify.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const org = await requireOrganizationId();
  if (!isOrgResult(org)) return org.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, code: "invalid_json", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const addressRaw =
    body.storefrontAddress && typeof body.storefrontAddress === "object"
      ? (body.storefrontAddress as Record<string, unknown>)
      : undefined;

  try {
    const result = await createGbpLocationForOrg({
      orgId: org.orgId,
      createdByUserId: auth.user.userId,
      googleAccountName: String(body.googleAccountName || ""),
      requestId: String(body.requestId || ""),
      title: String(body.title || ""),
      languageCode: String(body.languageCode || ""),
      storeCode:
        body.storeCode !== undefined ? String(body.storeCode) : undefined,
      websiteUri:
        body.websiteUri !== undefined ? String(body.websiteUri) : undefined,
      primaryPhone:
        body.primaryPhone !== undefined
          ? String(body.primaryPhone)
          : undefined,
      primaryCategoryName:
        body.primaryCategoryName !== undefined
          ? String(body.primaryCategoryName)
          : undefined,
      storefrontAddress: addressRaw
        ? {
            addressLines: Array.isArray(addressRaw.addressLines)
              ? addressRaw.addressLines.map((l) => String(l))
              : undefined,
            locality:
              addressRaw.locality !== undefined
                ? String(addressRaw.locality)
                : undefined,
            administrativeArea:
              addressRaw.administrativeArea !== undefined
                ? String(addressRaw.administrativeArea)
                : undefined,
            postalCode:
              addressRaw.postalCode !== undefined
                ? String(addressRaw.postalCode)
                : undefined,
            regionCode:
              addressRaw.regionCode !== undefined
                ? String(addressRaw.regionCode)
                : undefined,
          }
        : undefined,
    });

    await auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "gbp.location.create",
      success: true,
      target: {
        orgId: org.orgId,
        locationId: result.location.id,
        googleLocationName: result.googleLocationName,
        googleAccountName: result.googleAccountName,
        reusedIdempotentResult: result.reusedIdempotentResult,
        businessId: result.location.businessId,
      },
    });

    return NextResponse.json({
      success: true,
      ...result,
      assignmentNote:
        "Location is unassigned. Use Super Admin business assignment to link it explicitly — never automatic.",
    });
  } catch (err) {
    if (
      err instanceof CreateGbpLocationError ||
      err instanceof GoogleBusinessApiError ||
      err instanceof GoogleOAuthError
    ) {
      const fieldIssues =
        err instanceof CreateGbpLocationError
          ? err.fieldIssues
          : err instanceof GoogleBusinessApiError
            ? err.fieldViolations.map((v) => ({
                field: v.field,
                message: v.description,
              }))
            : undefined;
      await auditLog({
        actorId: auth.user.userId,
        actorRole: auth.user.role,
        action: "gbp.location.create",
        success: false,
        code: err.code,
        target: {
          orgId: org.orgId,
          googleAccountName: String(body.googleAccountName || ""),
          fieldCount: fieldIssues?.length || 0,
          googleStatus:
            err instanceof GoogleBusinessApiError ? err.googleStatus : undefined,
        },
      });
      return NextResponse.json(
        {
          success: false,
          code: err.code,
          message: err.message,
          ...(fieldIssues && fieldIssues.length
            ? { fieldIssues }
            : {}),
          ...(err instanceof GoogleBusinessApiError && err.googleStatus
            ? { googleStatus: err.googleStatus }
            : {}),
        },
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
      "Create Google location failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "create_failed",
        message: "Failed to create Google Business Profile location.",
      },
      { status: 500 }
    );
  }
}
