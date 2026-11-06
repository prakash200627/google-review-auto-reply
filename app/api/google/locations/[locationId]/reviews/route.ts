import { NextResponse } from "next/server";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import {
  listStoredReviewsForLocation,
  syncReviewsForLocation,
} from "@/lib/google/syncReviews";
import {
  assertUserCanAccessLocation,
  isOrgUserResult,
  requireOrgAndUserAccess,
} from "@/lib/auth/googleRouteAuth";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  EntitlementError,
  entitlementErrorResponse,
} from "@/lib/entitlements/enforce";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ locationId: string }> };

/** List reviews already stored for an authorized org location. */
export async function GET(
  _request: Request,
  context: RouteContext
) {
  const access = await requireOrgAndUserAccess();
  if (!isOrgUserResult(access)) return access.response;

  const { locationId } = await context.params;
  const locAccess = await assertUserCanAccessLocation({
    user: access.user,
    orgId: access.orgId,
    locationId,
  });
  if (!locAccess.ok) return locAccess.response;

  try {
    const reviews = await listStoredReviewsForLocation({
      orgId: access.orgId,
      locationId,
    });
    return NextResponse.json({ success: true, reviews });
  } catch (err) {
    if (err instanceof GoogleBusinessApiError) {
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
      );
    }
    console.error(
      "List reviews failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "list_failed",
        message: "Could not load stored reviews",
      },
      { status: 500 }
    );
  }
}

/**
 * Retrieve reviews from Google for this location (list only) and upsert locally.
 * Does not create, update, or delete review replies.
 */
export async function POST(
  request: Request,
  context: RouteContext
) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const access = await requireOrgAndUserAccess();
  if (!isOrgUserResult(access)) return access.response;

  const { locationId } = await context.params;
  const locAccess = await assertUserCanAccessLocation({
    user: access.user,
    orgId: access.orgId,
    locationId,
  });
  if (!locAccess.ok) return locAccess.response;

  try {
    const result = await syncReviewsForLocation({
      orgId: access.orgId,
      locationId,
    });
    return NextResponse.json({
      success: true,
      upserted: result.upserted,
      totalReviewCount: result.totalReviewCount,
      reviews: result.reviews,
    });
  } catch (err) {
    if (err instanceof EntitlementError) {
      return entitlementErrorResponse(err);
    }
    if (
      err instanceof GoogleBusinessApiError ||
      err instanceof GoogleOAuthError
    ) {
      return NextResponse.json(
        {
          success: false,
          code: err.code,
          message: err.message,
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
            "Stored Google credentials could not be decrypted. Reconnect Google.",
        },
        { status: 500 }
      );
    }
    console.error(
      "Review sync failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "sync_failed",
        message: "Failed to retrieve reviews from Google",
      },
      { status: 500 }
    );
  }
}
