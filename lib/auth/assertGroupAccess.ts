import mongoose from "mongoose";
import { NextResponse } from "next/server";
import type { AuthUser } from "@/lib/auth/authorize";
import { listActiveBusinessIdsForUser } from "@/lib/auth/authorize";
import { assertSuperAdminActiveOrgMatches } from "@/lib/auth/resolveOrgContext";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";

export type GroupAccessDoc = {
  _id: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  orgId: mongoose.Types.ObjectId;
  active?: boolean;
};

/**
 * Verify the caller may inspect a BusinessGroup dashboard / Reviews filter.
 * SA: group must belong to the active organization session.
 * BA: only groups listed on User.groupIds.
 * Member businesses are always re-derived from Business.groupId (never trusted from client).
 */
export async function assertGroupAccess(
  user: AuthUser,
  groupId: string
): Promise<
  | {
      ok: true;
      group: GroupAccessDoc;
      /** Authorized member business ids (intersection of group members ∩ user access). */
      memberBusinessIds: string[];
    }
  | { ok: false; response: NextResponse }
> {
  if (!mongoose.isValidObjectId(groupId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, code: "invalid_id", message: "Invalid group id." },
        { status: 400 }
      ),
    };
  }

  await connectToDatabase();
  const group = await BusinessGroup.findById(groupId)
    .select("name description orgId active")
    .lean();

  if (!group) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, code: "not_found", message: "Group not found." },
        { status: 404 }
      ),
    };
  }

  if (user.role !== "superadmin") {
    const allowed = user.groupIds || [];
    if (!allowed.includes(String(group._id))) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            success: false,
            code: "forbidden",
            message: "You do not have access to this group.",
          },
          { status: 403 }
        ),
      };
    }
  } else {
    const orgMatch = await assertSuperAdminActiveOrgMatches(
      user,
      group.orgId ? String(group.orgId) : null
    );
    if (!orgMatch.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            success: false,
            code: orgMatch.code,
            message: orgMatch.message,
          },
          { status: orgMatch.status }
        ),
      };
    }
  }

  const members = await Business.find({ groupId: group._id })
    .select("_id")
    .lean();
  const memberIds = members.map((b) => String(b._id));
  // SA Reviews/ORM scope: members already org-filtered via group.orgId match.
  // BA: intersect with assignment-based active businesses.
  const authorized =
    user.role === "superadmin"
      ? memberIds
      : await listActiveBusinessIdsForUser(user);
  const authorizedSet = new Set(authorized);
  const memberBusinessIds = memberIds.filter((id) => authorizedSet.has(id));

  return {
    ok: true,
    group: group as GroupAccessDoc,
    memberBusinessIds,
  };
}
