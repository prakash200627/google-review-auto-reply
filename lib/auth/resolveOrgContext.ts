import mongoose from "mongoose";
import type { AuthUser } from "@/lib/auth/authorize";
import { userHasOrgAccess } from "@/lib/auth/googleRouteAuth";
import { lifecycleAllowsOwnerAccess } from "@/lib/business/lifecycle";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { readOrganizationId } from "@/lib/org/session";

/**
 * Resolve the Google workspace org for a signed-in user.
 *
 * Prefer the signed org cookie when the user is authorized for it.
 * For business owners without a cookie (platform Google / no OAuth),
 * fall back to the org of their first lifecycle-active business.
 * Super Admins without a cookie must select an org explicitly.
 */
export async function resolveAuthorizedOrgId(
  user: AuthUser
): Promise<string | null> {
  const cookieOrgId = await readOrganizationId();
  if (cookieOrgId && (await userHasOrgAccess(user, cookieOrgId))) {
    return cookieOrgId;
  }

  if (user.role === "superadmin") {
    return null;
  }

  await connectToDatabase();
  const orFilters: Record<string, unknown>[] = [{ ownerUserId: user.userId }];
  if (user.businessIds.length > 0) {
    orFilters.push({ _id: { $in: user.businessIds } });
  }
  if ((user.groupIds || []).length > 0) {
    orFilters.push({ groupId: { $in: user.groupIds } });
  }

  const businesses = await Business.find({ $or: orFilters })
    .select("orgId active status")
    .lean();

  for (const biz of businesses) {
    if (!lifecycleAllowsOwnerAccess(biz)) continue;
    const orgId = biz.orgId ? String(biz.orgId) : "";
    if (orgId && mongoose.isValidObjectId(orgId)) {
      return orgId;
    }
  }
  return null;
}

/**
 * Super Admin ORM/GMB resource pages must stay inside the active org session.
 * Business Admins are gated by assignment (assertBusinessAccess / groupIds),
 * so this helper is a no-op for them.
 */
export async function assertSuperAdminActiveOrgMatches(
  user: AuthUser,
  resourceOrgId: string | null | undefined
): Promise<
  | { ok: true; orgId: string | null }
  | { ok: false; status: number; code: string; message: string }
> {
  if (user.role !== "superadmin") {
    return { ok: true, orgId: resourceOrgId ? String(resourceOrgId) : null };
  }

  const activeOrgId = await resolveAuthorizedOrgId(user);
  if (!activeOrgId) {
    return {
      ok: false,
      status: 403,
      code: "org_required",
      message:
        "Select an active organization session before opening this workspace resource.",
    };
  }

  if (
    !resourceOrgId ||
    !mongoose.isValidObjectId(String(resourceOrgId)) ||
    String(resourceOrgId) !== activeOrgId
  ) {
    return {
      ok: false,
      status: 403,
      code: "org_mismatch",
      message:
        "This resource belongs to a different organization than your active session.",
    };
  }

  return { ok: true, orgId: activeOrgId };
}
