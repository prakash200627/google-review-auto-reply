import mongoose from "mongoose";
import type { AuthUser } from "@/lib/auth/authorize";
import { listActiveBusinessIdsForUser } from "@/lib/auth/authorize";
import { resolveAuthorizedOrgId } from "@/lib/auth/resolveOrgContext";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";

export type ReviewsBusinessScope =
  | {
      ok: true;
      orgId: string | null;
      businessIds: string[];
    }
  | {
      ok: false;
      status: number;
      code: "org_required";
      message: string;
      businessIds: [];
      orgId: null;
    };

/**
 * Business ids visible in the Reviews workspace.
 *
 * - Business Admin: assignment-based (unchanged).
 * - Super Admin: active organization cookie only (aligned with ORM dashboards).
 *   Platform-wide Admin APIs remain on `/api/admin/*`.
 */
export async function resolveReviewsBusinessScope(
  user: AuthUser
): Promise<ReviewsBusinessScope> {
  if (user.role !== "superadmin") {
    const businessIds = await listActiveBusinessIdsForUser(user);
    const orgId = await resolveAuthorizedOrgId(user);
    return { ok: true, orgId, businessIds };
  }

  const orgId = await resolveAuthorizedOrgId(user);
  if (!orgId) {
    return {
      ok: false,
      status: 403,
      code: "org_required",
      message:
        "Select an active organization before opening Reviews. Use Admin → Businesses to set the workspace organization.",
      businessIds: [],
      orgId: null,
    };
  }

  await connectToDatabase();
  const rows = await Business.find({
    orgId: new mongoose.Types.ObjectId(orgId),
  })
    .select("_id")
    .lean();

  return {
    ok: true,
    orgId,
    businessIds: rows.map((b) => String(b._id)),
  };
}
