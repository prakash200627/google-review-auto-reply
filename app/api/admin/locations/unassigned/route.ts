import { NextResponse } from "next/server";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import {
  ADMIN_LOCATION_LIST_LIMITS,
  buildLocationIdentityKey,
  clampAdminLocationLimit,
  clampAdminLocationOffset,
  dedupeLocationsByIdentity,
  paginateSlice,
} from "@/lib/location/identity";
import { connectToDatabase } from "@/lib/mongodb";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";
import { Location } from "@/models/Location";

export const runtime = "nodejs";

/**
 * Unassigned locations for the Super Admin's active organization only.
 * Bounded + deduped. Does not call live Google APIs.
 */
export async function GET(request: Request) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const org = await requireOrganizationId();
  if (!isOrgResult(org)) return org.response;

  const { searchParams } = new URL(request.url);
  const limit = clampAdminLocationLimit(
    searchParams.get("limit") || ADMIN_LOCATION_LIST_LIMITS.defaultLimit
  );
  const offset = clampAdminLocationOffset(searchParams.get("offset"));

  await connectToDatabase();
  const raw = await Location.find({
    orgId: org.orgId,
    $or: [{ businessId: null }, { businessId: { $exists: false } }],
  })
    .sort({ title: 1, updatedAt: -1 })
    .select("title address googleLocationName orgId updatedAt businessId")
    .limit(ADMIN_LOCATION_LIST_LIMITS.maxScan)
    .lean();

  const { unique, skippedInvalid, duplicateCollapsed } =
    dedupeLocationsByIdentity(raw);

  const scoped = unique.filter((loc) => String(loc.orgId) === org.orgId);

  const mapped = scoped.map((loc) => {
    const orgId = String(loc.orgId);
    const googleLocationName = String(loc.googleLocationName);
    const identityKey = buildLocationIdentityKey(orgId, googleLocationName)!;
    const address =
      typeof loc.address === "string" && loc.address.trim()
        ? loc.address.trim()
        : "";
    return {
      id: String(loc._id),
      title: loc.title || "",
      address,
      addressUnavailable: !address,
      googleLocationName,
      orgId,
      identityKey,
    };
  });

  const { page, hasMore, totalMatched } = paginateSlice(mapped, offset, limit);

  return NextResponse.json({
    success: true,
    source: "mongodb_discovery_cache",
    orgId: org.orgId,
    limit,
    offset,
    totalMatched,
    totalReturned: page.length,
    hasMore,
    skippedInvalid,
    duplicateCollapsed,
    locations: page,
  });
}
