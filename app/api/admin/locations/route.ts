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
import { Business } from "@/models/Business";
import { GoogleConnection } from "@/models/GoogleConnection";
import { Location } from "@/models/Location";

export const runtime = "nodejs";

export type LocationSelectability =
  | "available"
  | "already_assigned"
  | "no_usable_connection";

/**
 * Searchable GBP locations from the MongoDB discovery cache for the Super
 * Admin's active (signed) organization session only.
 * Does not call live Google APIs.
 * Deduplicates by validated googleLocationName within that org.
 * Rows missing a valid Google location resource name are excluded.
 */
export async function GET(request: Request) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const org = await requireOrganizationId();
  if (!isOrgResult(org)) return org.response;

  const { searchParams } = new URL(request.url);
  const q = String(searchParams.get("q") || "")
    .trim()
    .toLowerCase();
  const includeAssigned = searchParams.get("includeAssigned") === "1";
  const usableOnly = searchParams.get("usableOnly") === "1";
  const limit = clampAdminLocationLimit(searchParams.get("limit"));
  const offset = clampAdminLocationOffset(searchParams.get("offset"));

  // Client-supplied orgId is ignored for authorization — cookie is authoritative.
  // If a client sends a different orgId, reject rather than silently mixing scopes.
  const clientOrgId = searchParams.get("orgId");
  if (clientOrgId && String(clientOrgId).trim() !== org.orgId) {
    return NextResponse.json(
      {
        success: false,
        code: "org_scope_mismatch",
        message:
          "Location search is scoped to the active Google workspace cookie. Select that organization first; do not pass a different orgId.",
      },
      { status: 403 }
    );
  }

  await connectToDatabase();

  const filter: Record<string, unknown> = { orgId: org.orgId };
  if (!includeAssigned) {
    filter.$or = [{ businessId: null }, { businessId: { $exists: false } }];
  }

  const raw = await Location.find(filter)
    .sort({ title: 1, updatedAt: -1 })
    .select(
      "title address googleLocationName googleAccountName businessInfoName placeId orgId businessId updatedAt"
    )
    .limit(ADMIN_LOCATION_LIST_LIMITS.maxScan)
    .lean();

  const { unique, skippedInvalid, duplicateCollapsed } =
    dedupeLocationsByIdentity(raw);

  // Defense in depth: never return another organization's rows even if a
  // caller/mock returns mixed documents.
  let locations = unique.filter((loc) => String(loc.orgId) === org.orgId);
  if (q) {
    locations = locations.filter((loc) => {
      const hay =
        `${loc.title || ""} ${loc.address || ""} ${loc.googleLocationName || ""} ${loc.placeId || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const businessIds = locations
    .map((l) => l.businessId)
    .filter(Boolean)
    .map((id) => String(id));

  const [businesses, connections] = await Promise.all([
    businessIds.length
      ? Business.find({ _id: { $in: businessIds } })
          .select("name")
          .lean()
      : Promise.resolve([]),
    GoogleConnection.find({
      orgId: org.orgId,
      status: { $in: ["active", "error"] },
      businessId: null,
    })
      .select("orgId status googleAccountEmail connectionSource")
      .lean(),
  ]);

  const bizById = new Map(businesses.map((b) => [String(b._id), b]));
  const conn = connections[0] || null;
  const usableConnection = conn?.status === "active";

  let mapped = locations.map((loc) => {
    const orgId = String(loc.orgId);
    const googleLocationName = String(loc.googleLocationName);
    const identityKey = buildLocationIdentityKey(orgId, googleLocationName)!;
    const assignedId = loc.businessId ? String(loc.businessId) : null;
    const assignedBiz = assignedId ? bizById.get(assignedId) : null;
    let selectability: LocationSelectability = "available";
    if (assignedId) selectability = "already_assigned";
    else if (!usableConnection) selectability = "no_usable_connection";

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
      googleAccountName: loc.googleAccountName || "",
      businessInfoName: loc.businessInfoName || "",
      placeId: loc.placeId || "",
      orgId,
      identityKey,
      assigned: Boolean(assignedId),
      assignedBusinessId: assignedId,
      assignedBusinessName: assignedBiz?.name || null,
      selectability,
      selectable: selectability === "available",
      connection: conn
        ? {
            status: conn.status,
            email: conn.googleAccountEmail || "",
            connectionSource: conn.connectionSource || "platform",
          }
        : null,
    };
  });

  if (usableOnly) {
    mapped = mapped.filter((l) => l.selectable);
  }

  const { page, hasMore, totalMatched } = paginateSlice(mapped, offset, limit);

  return NextResponse.json({
    success: true,
    source: "mongodb_discovery_cache",
    orgId: org.orgId,
    query: q,
    limit,
    offset,
    totalMatched,
    totalReturned: page.length,
    hasMore,
    skippedInvalid,
    duplicateCollapsed,
    scanCap: ADMIN_LOCATION_LIST_LIMITS.maxScan,
    locations: page,
    note:
      hasMore || totalMatched >= ADMIN_LOCATION_LIST_LIMITS.maxScan
        ? "Results are bounded. Refine search or load the next page (offset) to see more distinct locations in this organization."
        : undefined,
  });
}
