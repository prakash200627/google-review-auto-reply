import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";
import { User } from "@/models/User";

export class GroupMembershipError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "GroupMembershipError";
    this.code = code;
    this.status = status;
  }
}

function uniqueObjectIds(ids: mongoose.Types.ObjectId[]): mongoose.Types.ObjectId[] {
  const seen = new Set<string>();
  const out: mongoose.Types.ObjectId[] = [];
  for (const id of ids) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * Recompute a Business Admin's businessIds from their groupIds plus any
 * businesses they still own as primary ownerUserId. Never invents access.
 */
export async function syncOwnerBusinessIdsFromGroups(
  userId: string
): Promise<string[]> {
  if (!mongoose.isValidObjectId(userId)) return [];
  await connectToDatabase();
  const user = await User.findById(userId)
    .select("role groupIds businessIds")
    .exec();
  if (!user || user.role !== "business_owner") return [];

  const groupIds = (user.groupIds || []).map((id) => String(id));
  const fromGroups =
    groupIds.length > 0
      ? await Business.find({ groupId: { $in: groupIds } })
          .select("_id")
          .lean()
      : [];

  const owned = await Business.find({ ownerUserId: user._id })
    .select("_id")
    .lean();

  const next = uniqueObjectIds([
    ...fromGroups.map((b) => b._id),
    ...owned.map((b) => b._id),
  ]);
  user.businessIds = next;
  await user.save();
  return next.map(String);
}

/**
 * After a business moves groups (or is ungrouped), refresh every Business
 * Admin who belongs to the old and/or new group.
 */
export async function refreshOwnersForBusinessGroupChange(input: {
  previousGroupId: string | null;
  nextGroupId: string | null;
}): Promise<void> {
  const ids = [input.previousGroupId, input.nextGroupId].filter(
    (id): id is string => Boolean(id && mongoose.isValidObjectId(id))
  );
  if (ids.length === 0) return;
  await connectToDatabase();
  const owners = await User.find({
    role: "business_owner",
    groupIds: { $in: ids },
  })
    .select("_id")
    .lean();
  for (const owner of owners) {
    await syncOwnerBusinessIdsFromGroups(String(owner._id));
  }
}

export async function assignOwnerToGroups(input: {
  userId: string;
  groupIds: string[];
}): Promise<{ groupIds: string[]; businessIds: string[] }> {
  const { userId, groupIds } = input;
  if (!mongoose.isValidObjectId(userId)) {
    throw new GroupMembershipError("Invalid user id.", {
      code: "invalid_id",
      status: 400,
    });
  }
  for (const id of groupIds) {
    if (!mongoose.isValidObjectId(id)) {
      throw new GroupMembershipError(`Invalid group id: ${id}`, {
        code: "invalid_group_id",
        status: 400,
      });
    }
  }

  await connectToDatabase();
  const user = await User.findById(userId).select("role groupIds").exec();
  if (!user || user.role !== "business_owner") {
    throw new GroupMembershipError(
      "Only Business Admin accounts can be assigned to groups.",
      { code: "invalid_role", status: 400 }
    );
  }

  const unique = [...new Set(groupIds)];
  if (unique.length > 0) {
    const found = await BusinessGroup.find({ _id: { $in: unique } })
      .select("_id")
      .lean();
    if (found.length !== unique.length) {
      throw new GroupMembershipError(
        "One or more groups were not found.",
        { code: "group_not_found", status: 404 }
      );
    }
  }

  user.groupIds = unique.map((id) => new mongoose.Types.ObjectId(id));
  await user.save();
  const businessIds = await syncOwnerBusinessIdsFromGroups(userId);
  return { groupIds: unique, businessIds };
}

export async function setBusinessGroup(input: {
  businessId: string;
  groupId: string | null;
  session?: mongoose.ClientSession | null;
  /** Skip owner businessId recompute (caller may run after commit). */
  skipOwnerRefresh?: boolean;
}): Promise<{ previousGroupId: string | null; groupId: string | null }> {
  const { businessId, groupId, session, skipOwnerRefresh } = input;
  if (!mongoose.isValidObjectId(businessId)) {
    throw new GroupMembershipError("Invalid business id.", {
      code: "invalid_id",
      status: 400,
    });
  }
  if (groupId !== null && !mongoose.isValidObjectId(groupId)) {
    throw new GroupMembershipError("Invalid group id.", {
      code: "invalid_group_id",
      status: 400,
    });
  }

  await connectToDatabase();
  const businessQuery = Business.findById(businessId).select("groupId orgId");
  if (session) businessQuery.session(session);
  const business = await businessQuery.exec();
  if (!business) {
    throw new GroupMembershipError("Business not found.", {
      code: "not_found",
      status: 404,
    });
  }

  if (groupId) {
    const groupQuery = BusinessGroup.findById(groupId).select("orgId active");
    if (session) groupQuery.session(session);
    const group = await groupQuery.lean();
    if (!group) {
      throw new GroupMembershipError("Group not found.", {
        code: "group_not_found",
        status: 404,
      });
    }
    if (String(group.orgId) !== String(business.orgId)) {
      throw new GroupMembershipError(
        "Group and business must share the same Google organization workspace.",
        { code: "org_mismatch", status: 400 }
      );
    }
    if (group.active === false) {
      throw new GroupMembershipError("Cannot assign a business to an inactive group.", {
        code: "group_inactive",
        status: 400,
      });
    }
  }

  const previousGroupId = business.groupId ? String(business.groupId) : null;
  business.groupId = groupId
    ? new mongoose.Types.ObjectId(groupId)
    : null;
  await business.save(session ? { session } : undefined);
  if (!skipOwnerRefresh) {
    await refreshOwnersForBusinessGroupChange({
      previousGroupId,
      nextGroupId: groupId,
    });
  }
  return { previousGroupId, groupId };
}

/** Business ids a Business Admin may access via groups + direct businessIds. */
export async function listAccessibleBusinessIdsForOwner(
  userId: string,
  businessIds: string[],
  groupIds: string[]
): Promise<string[]> {
  await connectToDatabase();
  const fromGroups =
    groupIds.length > 0
      ? await Business.find({ groupId: { $in: groupIds } })
          .select("_id")
          .lean()
      : [];
  const owned = await Business.find({ ownerUserId: userId })
    .select("_id")
    .lean();
  const set = new Set<string>([
    ...businessIds,
    ...fromGroups.map((b) => String(b._id)),
    ...owned.map((b) => String(b._id)),
  ]);
  return [...set];
}
