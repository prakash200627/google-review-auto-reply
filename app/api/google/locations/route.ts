import { NextResponse } from "next/server";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import {
  listStoredLocationsForOrg,
  syncLocationsForOrg,
} from "@/lib/google/syncLocations";
import { listActiveBusinessIdsForUser } from "@/lib/auth/authorize";
import {
  isOrgUserResult,
  requireOrgAndUserAccess,
} from "@/lib/auth/googleRouteAuth";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { connectToDatabase } from "@/lib/mongodb";
import { Location } from "@/models/Location";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";

export const runtime = "nodejs";

/** List locations for the signed-in user's authorized Google organization. */
export async function GET() {
  const access = await requireOrgAndUserAccess();
  if (!isOrgUserResult(access)) return access.response;

  try {
    const locations = await listStoredLocationsForOrg(access.orgId);

    if (access.user.role === "superadmin") {
      return NextResponse.json({ success: true, locations });
    }

    const activeIds = await listActiveBusinessIdsForUser(access.user);
    await connectToDatabase();
    const docs = await Location.find({
      orgId: access.orgId,
      businessId: { $in: activeIds },
    })
      .select("_id")
      .lean();
    const allowed = new Set(docs.map((d) => String(d._id)));
    return NextResponse.json({
      success: true,
      locations: locations.filter((loc) => allowed.has(loc.id)),
    });
  } catch (err) {
    console.error(
      "List locations failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "list_failed",
        message: "Could not load stored locations",
      },
      { status: 500 }
    );
  }
}

/**
 * Discover accounts/locations from Google (read-only list APIs) and upsert locally.
 * Super Admin only — business owners must not trigger org-wide location upserts.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const access = await requireOrgAndUserAccess();
  if (!isOrgUserResult(access)) return access.response;

  if (access.user.role !== "superadmin") {
    return NextResponse.json(
      {
        success: false,
        code: "forbidden",
        message:
          "Only a Super Admin can discover and upsert Google locations for this organization. Business owners can use locations already assigned to their business.",
      },
      { status: 403 }
    );
  }

  try {
    const result = await syncLocationsForOrg(access.orgId);
    return NextResponse.json({
      success: true,
      discovered: result.discovered,
      locations: result.locations,
    });
  } catch (err) {
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
      "Location discovery failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "discovery_failed",
        message: "Failed to discover Google Business Profile locations",
      },
      { status: 500 }
    );
  }
}
