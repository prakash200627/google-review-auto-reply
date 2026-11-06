import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  assignOwnerToGroups,
  GroupMembershipError,
  setBusinessGroup,
  syncOwnerBusinessIdsFromGroups,
} from "@/lib/groups/membership";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";
import { User } from "@/models/User";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ groupId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const { groupId } = await context.params;
  if (!mongoose.isValidObjectId(groupId)) {
    return NextResponse.json(
      { success: false, message: "Invalid group id." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const group = await BusinessGroup.findById(groupId).lean();
  if (!group) {
    return NextResponse.json(
      { success: false, message: "Group not found." },
      { status: 404 }
    );
  }

  const [businesses, admins] = await Promise.all([
    Business.find({ groupId })
      .select("_id name active status locationIds")
      .lean(),
    User.find({ role: "business_owner", groupIds: groupId })
      .select("_id email name active businessIds")
      .lean(),
  ]);

  return NextResponse.json({
    success: true,
    group: {
      id: String(group._id),
      name: group.name,
      description: group.description || "",
      orgId: String(group.orgId),
      active: group.active !== false,
      businesses: businesses.map((b) => ({
        id: String(b._id),
        name: b.name,
        active: b.active,
      })),
      admins: admins.map((a) => ({
        id: String(a._id),
        email: a.email,
        name: a.name || "",
        active: Boolean(a.active),
      })),
    },
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const { groupId } = await context.params;
  if (!mongoose.isValidObjectId(groupId)) {
    return NextResponse.json(
      { success: false, message: "Invalid group id." },
      { status: 400 }
    );
  }

  let body: {
    name?: unknown;
    description?: unknown;
    active?: unknown;
    /** Assign these business ids into this group (moves them). */
    businessIds?: unknown;
    /** Replace Business Admin membership for this group. */
    adminUserIds?: unknown;
    /** Add one admin by email (must already be a business_owner). */
    addAdminUserId?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const group = await BusinessGroup.findById(groupId).exec();
  if (!group) {
    return NextResponse.json(
      { success: false, message: "Group not found." },
      { status: 404 }
    );
  }

  if (typeof body.name === "string" && body.name.trim()) {
    group.name = body.name.trim().slice(0, 120);
  }
  if (typeof body.description === "string") {
    group.description = body.description.trim().slice(0, 1000);
  }
  if (typeof body.active === "boolean") {
    group.active = body.active;
  }
  await group.save();

  if (Array.isArray(body.businessIds)) {
    const ids = body.businessIds.map((id) => String(id));
    for (const id of ids) {
      if (!mongoose.isValidObjectId(id)) {
        return NextResponse.json(
          { success: false, message: `Invalid business id: ${id}` },
          { status: 400 }
        );
      }
    }
    try {
      const current = await Business.find({ groupId })
        .select("_id")
        .lean();
      const nextSet = new Set(ids);
      for (const b of current) {
        if (!nextSet.has(String(b._id))) {
          await setBusinessGroup({
            businessId: String(b._id),
            groupId: null,
          });
        }
      }
      for (const id of ids) {
        await setBusinessGroup({ businessId: id, groupId });
      }
    } catch (err) {
      if (err instanceof GroupMembershipError) {
        return NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        );
      }
      throw err;
    }
  }

  if (Array.isArray(body.adminUserIds)) {
    const adminIds = body.adminUserIds.map((id) => String(id));
    for (const id of adminIds) {
      if (!mongoose.isValidObjectId(id)) {
        return NextResponse.json(
          { success: false, message: `Invalid admin user id: ${id}` },
          { status: 400 }
        );
      }
    }
    const currently = await User.find({
      role: "business_owner",
      groupIds: groupId,
    })
      .select("_id groupIds")
      .exec();
    const nextSet = new Set(adminIds);

    for (const user of currently) {
      if (!nextSet.has(String(user._id))) {
        user.groupIds = (user.groupIds || []).filter(
          (gid) => String(gid) !== groupId
        );
        await user.save();
        await syncOwnerBusinessIdsFromGroups(String(user._id));
      }
    }

    for (const id of adminIds) {
      const user = await User.findById(id).select("role groupIds").exec();
      if (!user || user.role !== "business_owner") {
        return NextResponse.json(
          {
            success: false,
            code: "invalid_role",
            message: `User ${id} is not a Business Admin.`,
          },
          { status: 400 }
        );
      }
      const existing = (user.groupIds || []).map(String);
      if (!existing.includes(groupId)) {
        try {
          await assignOwnerToGroups({
            userId: id,
            groupIds: [...existing, groupId],
          });
        } catch (err) {
          if (err instanceof GroupMembershipError) {
            return NextResponse.json(
              { success: false, code: err.code, message: err.message },
              { status: err.status }
            );
          }
          throw err;
        }
      }
    }
  }

  if (
    typeof body.addAdminUserId === "string" &&
    mongoose.isValidObjectId(body.addAdminUserId)
  ) {
    const user = await User.findById(body.addAdminUserId)
      .select("role groupIds")
      .exec();
    if (!user || user.role !== "business_owner") {
      return NextResponse.json(
        {
          success: false,
          message: "Only Business Admin accounts can join a group.",
        },
        { status: 400 }
      );
    }
    const existing = (user.groupIds || []).map(String);
    if (!existing.includes(groupId)) {
      try {
        await assignOwnerToGroups({
          userId: String(user._id),
          groupIds: [...existing, groupId],
        });
      } catch (err) {
        if (err instanceof GroupMembershipError) {
          return NextResponse.json(
            { success: false, code: err.code, message: err.message },
            { status: err.status }
          );
        }
        throw err;
      }
    }
  }

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "group.update",
    success: true,
    target: { groupId },
  });

  return NextResponse.json({
    success: true,
    message: "Group updated.",
    groupId,
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const { groupId } = await context.params;
  if (!mongoose.isValidObjectId(groupId)) {
    return NextResponse.json(
      { success: false, message: "Invalid group id." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const group = await BusinessGroup.findById(groupId).lean();
  if (!group) {
    return NextResponse.json(
      { success: false, message: "Group not found." },
      { status: 404 }
    );
  }

  const businessCount = await Business.countDocuments({ groupId });
  if (businessCount > 0) {
    return NextResponse.json(
      {
        success: false,
        code: "group_not_empty",
        message:
          "Ungroup or move all businesses out of this group before deleting it. Google locations and reviews are not deleted.",
      },
      { status: 409 }
    );
  }

  const admins = await User.find({
    role: "business_owner",
    groupIds: groupId,
  })
    .select("_id groupIds")
    .exec();
  for (const user of admins) {
    user.groupIds = (user.groupIds || []).filter(
      (gid) => String(gid) !== groupId
    );
    await user.save();
    await syncOwnerBusinessIdsFromGroups(String(user._id));
  }

  await BusinessGroup.deleteOne({ _id: groupId });

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "group.delete",
    success: true,
    target: { groupId },
  });

  return NextResponse.json({
    success: true,
    message: "Group deleted. No Google data was modified.",
  });
}
