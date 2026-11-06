import { NextResponse } from "next/server";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import {
  fetchOptionsForLocation,
  VerificationServiceError,
} from "@/lib/google/verification";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ locationId: string }> };

/**
 * Fetch eligible verification methods from Google for this location.
 * Super Admin only. Returns only methods Google actually returns.
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

  let body: { languageCode?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const languageCode = String(body.languageCode || "en").trim() || "en";

  try {
    const result = await fetchOptionsForLocation(
      org.orgId,
      locationId,
      languageCode
    );
    return NextResponse.json({
      success: true,
      languageCode: result.languageCode,
      locationName: result.locationName,
      options: result.options,
      empty: result.options.length === 0,
      message:
        result.options.length === 0
          ? "Google returned no verification methods for this location and language. No fallback methods are offered."
          : undefined,
    });
  } catch (err) {
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
      "Fetch verification options failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "options_failed",
        message: "Could not fetch verification options from Google.",
      },
      { status: 500 }
    );
  }
}
