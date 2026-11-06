import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  isAuthUser,
  requireAuthUser,
  type AuthUser,
} from "@/lib/auth/authorize";
import {
  lifecycleAllowsOwnerAccess,
  resolveBusinessLifecycle,
} from "@/lib/business/lifecycle";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";
import { Organization } from "@/models/Organization";
import { Review } from "@/models/Review";
import { resolveAuthorizedOrgId } from "@/lib/auth/resolveOrgContext";
import { isOrgResult, requireOrganizationId } from "@/lib/org/requireOrg";
import { pickBusinessIdFromAssignment } from "@/lib/reviews/resolveReviewBusiness";

/**
 * Route inventory (authorization policy):
 *
 * OAuth:
 * - POST /api/auth/google/start   — Super Admin + signed org cookie
 * - GET  /api/auth/google/callback — OAuth state → org binding; sets signed cookie
 * - GET  /api/auth/google/status  — signed-in user + org access (safe fields only)
 *
 * Protected Google workspace ops (signed-in user + signed org session;
 * cookie signature is integrity only — membership/role still required):
 * - GET  /api/google/locations — assigned locations for owners; all for Super Admin
 * - POST /api/google/locations — Super Admin only (org-wide discovery/upsert)
 * - GET/POST /api/google/locations/[locationId]/reviews
 * - POST /api/reviews/[reviewId]/draft
 * - POST /api/reviews/[reviewId]/reply
 * - GET  /api/admin/google/accounts — Super Admin only (list accounts for create)
 * - POST /api/admin/google/locations — Super Admin only (accounts.locations.create)
 * - GET/POST /api/admin/google/locations/[locationId]/verification — SA status/refresh
 * - POST …/verification/options|start|complete — SA Verifications API workflow
 *
 * Super Admin business APIs use requireSuperAdmin separately.
 *
 * Organization access policy:
 * - Business owners: active Business membership under orgId via businessIds,
 *   ownerUserId, or groupIds (same vectors as assertBusinessAccess).
 * - Super Admins: any Organization that exists in this deployment, but only when the
 *   server-issued signed org cookie names that org (cannot forge another org id).
 * - Switching the active org cookie: Super Admin must call
 *   POST /api/admin/organizations/select (or complete Google OAuth). Clients cannot
 *   set the cookie; unsigned/forged values are rejected. Stale cookies for deleted
 *   orgs fail readOrganizationId. No per-admin org allowlist (single-deployment ops).
 */

export async function userHasOrgAccess(
  user: AuthUser,
  orgId: string
): Promise<boolean> {
  if (!mongoose.isValidObjectId(orgId)) return false;
  await connectToDatabase();
  const org = await Organization.findById(orgId).select("_id").lean();
  if (!org) return false;

  if (user.role === "superadmin") {
    // Explicit deployment policy: Super Admin may operate on existing orgs
    // referenced by a server-signed org session. Signature is checked upstream.
    return true;
  }

  const orFilters: Record<string, unknown>[] = [
    { ownerUserId: user.userId },
  ];
  if (user.businessIds.length > 0) {
    orFilters.push({ _id: { $in: user.businessIds } });
  }
  if ((user.groupIds || []).length > 0) {
    orFilters.push({ groupId: { $in: user.groupIds } });
  }

  const candidates = await Business.find({
    orgId,
    $or: orFilters,
  })
    .select("_id active status")
    .lean();
  return candidates.some((b) => lifecycleAllowsOwnerAccess(b));
}

async function assertOwnerBusinessActive(
  user: AuthUser,
  businessId: string
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const business = await Business.findById(businessId)
    .select("active status ownerUserId groupId")
    .lean();
  if (!business) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message: "You do not have access to this business.",
        },
        { status: 403 }
      ),
    };
  }
  const groupId = business.groupId ? String(business.groupId) : null;
  const owns =
    user.businessIds.includes(businessId) ||
    String(business.ownerUserId || "") === user.userId ||
    Boolean(groupId && (user.groupIds || []).includes(groupId));
  if (!owns) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message: "You do not have access to this business.",
        },
        { status: 403 }
      ),
    };
  }
  if (!lifecycleAllowsOwnerAccess(business)) {
    const status = resolveBusinessLifecycle(business);
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "business_lifecycle_blocked",
          message: `This business is ${status}. Contact a Super Admin.`,
        },
        { status: 403 }
      ),
    };
  }
  return { ok: true };
}

/**
 * Require a signed-in user authorized for a Google workspace org.
 * Prefer the signed org cookie; owners without a cookie may use their
 * business's orgId (platform Google / no owner OAuth).
 */
export async function requireOrgAndUserAccess(): Promise<
  { orgId: string; user: AuthUser } | { response: NextResponse }
> {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return { response: auth.response };

  const resolvedOrgId = await resolveAuthorizedOrgId(auth.user);
  if (resolvedOrgId) {
    return { orgId: resolvedOrgId, user: auth.user };
  }

  // Super Admin (or owner with no business) — require explicit org cookie.
  const org = await requireOrganizationId();
  if (!isOrgResult(org)) return { response: org.response };

  const allowed = await userHasOrgAccess(auth.user, org.orgId);
  if (!allowed) {
    return {
      response: NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message:
            "You are signed in but not authorized for this Google organization workspace.",
        },
        { status: 403 }
      ),
    };
  }

  return { orgId: org.orgId, user: auth.user };
}

export function isOrgUserResult(
  value: { orgId: string; user: AuthUser } | { response: NextResponse }
): value is { orgId: string; user: AuthUser } {
  return "orgId" in value && "user" in value;
}

export async function assertUserCanAccessLocation(input: {
  user: AuthUser;
  orgId: string;
  locationId: string;
}): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const { user, orgId, locationId } = input;
  if (!mongoose.isValidObjectId(locationId)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "invalid_id",
          message: "Invalid location id.",
        },
        { status: 400 }
      ),
    };
  }

  await connectToDatabase();
  const location = await Location.findOne({ _id: locationId, orgId })
    .select("businessId")
    .lean();

  if (!location) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "location_not_found",
          message: "Location not found for this organization.",
        },
        { status: 404 }
      ),
    };
  }

  if (user.role === "superadmin") {
    return { ok: true };
  }

  const businessId = location.businessId ? String(location.businessId) : null;
  if (!businessId) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message:
            "This location is unassigned. A Super Admin must assign it to your business first.",
        },
        { status: 403 }
      ),
    };
  }

  return assertOwnerBusinessActive(user, businessId);
}

export async function assertUserCanAccessReview(input: {
  user: AuthUser;
  orgId: string;
  reviewId: string;
}): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const { user, orgId, reviewId } = input;
  if (!mongoose.isValidObjectId(reviewId)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "invalid_id",
          message: "Invalid review id.",
        },
        { status: 400 }
      ),
    };
  }

  await connectToDatabase();
  const review = await Review.findOne({ _id: reviewId, orgId })
    .select("businessId locationId")
    .lean();

  if (!review) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "not_found",
          message: "Review not found for this organization.",
        },
        { status: 404 }
      ),
    };
  }

  if (user.role === "superadmin") {
    return { ok: true };
  }

  const location = await Location.findOne({
    _id: review.locationId,
    orgId,
  })
    .select("businessId")
    .lean();

  const businessId = pickBusinessIdFromAssignment(
    review.businessId,
    location?.businessId
  );

  if (!businessId) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "location_unassigned",
          message:
            "This review's Google location is not assigned to a business. A Super Admin must assign the location under Admin → Businesses first.",
        },
        { status: 403 }
      ),
    };
  }

  return assertOwnerBusinessActive(user, businessId);
}

/**
 * Filter stored locations for business owners (assigned only).
 * Prefer listVisibleLocationsForUser / listActiveBusinessIdsForUser for live
 * routes — those resolve group and ownerUserId membership. This helper only
 * filters by the caller's already-authorized businessId set.
 */
export function filterLocationsForUser<
  T extends { id: string; businessId?: string | null },
>(
  user: AuthUser,
  locations: T[],
  businessIdByLocationId: Map<string, string | null>,
  authorizedBusinessIds?: ReadonlySet<string> | readonly string[]
): T[] {
  if (user.role === "superadmin") return locations;
  const allowed =
    authorizedBusinessIds instanceof Set
      ? authorizedBusinessIds
      : new Set(
          Array.isArray(authorizedBusinessIds) && authorizedBusinessIds.length > 0
            ? authorizedBusinessIds
            : user.businessIds
        );
  return locations.filter((loc) => {
    const businessId = businessIdByLocationId.get(loc.id) ?? null;
    return Boolean(businessId && allowed.has(businessId));
  });
}
