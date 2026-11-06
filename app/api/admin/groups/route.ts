import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";
import { Organization } from "@/models/Organization";
import { User } from "@/models/User";
import { readOrganizationId } from "@/lib/org/session";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  await connectToDatabase();
  const groups = await BusinessGroup.find({}).sort({ name: 1 }).lean();
  const groupIds = groups.map((g) => g._id);
  const [businesses, admins] = await Promise.all([
    Business.find({ groupId: { $in: groupIds } })
      .select("_id name groupId active status")
      .lean(),
    User.find({
      role: "business_owner",
      groupIds: { $in: groupIds },
    })
      .select("_id email name groupIds active")
      .lean(),
  ]);

  const businessesByGroup = new Map<string, typeof businesses>();
  for (const b of businesses) {
    const key = String(b.groupId);
    const list = businessesByGroup.get(key) || [];
    list.push(b);
    businessesByGroup.set(key, list);
  }
  const adminsByGroup = new Map<string, typeof admins>();
  for (const a of admins) {
    for (const gid of a.groupIds || []) {
      const key = String(gid);
      const list = adminsByGroup.get(key) || [];
      list.push(a);
      adminsByGroup.set(key, list);
    }
  }

  return NextResponse.json({
    success: true,
    groups: groups.map((g) => {
      const biz = businessesByGroup.get(String(g._id)) || [];
      const adminList = adminsByGroup.get(String(g._id)) || [];
      const uniqueAdmins = [
        ...new Map(adminList.map((a) => [String(a._id), a])).values(),
      ];
      return {
        id: String(g._id),
        name: g.name,
        description: g.description || "",
        orgId: String(g.orgId),
        active: g.active !== false,
        businessCount: biz.length,
        businesses: biz.map((b) => ({
          id: String(b._id),
          name: b.name,
          active: b.active,
        })),
        adminCount: uniqueAdmins.length,
        admins: uniqueAdmins.map((a) => ({
          id: String(a._id),
          email: a.email,
          name: a.name || "",
          active: Boolean(a.active),
        })),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      };
    }),
  });
}

export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  let body: {
    name?: unknown;
    description?: unknown;
    orgId?: unknown;
    active?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const name = String(body.name || "").trim();
  if (!name) {
    return NextResponse.json(
      { success: false, message: "Group name is required." },
      { status: 400 }
    );
  }

  let orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  if (!orgId) {
    orgId = (await readOrganizationId()) || "";
  }
  if (!orgId || !mongoose.isValidObjectId(orgId)) {
    return NextResponse.json(
      {
        success: false,
        code: "org_required",
        message:
          "Select a Google organization workspace (cookie or orgId) before creating a group.",
      },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const org = await Organization.findById(orgId).select("_id").lean();
  if (!org) {
    return NextResponse.json(
      { success: false, message: "Organization not found." },
      { status: 400 }
    );
  }

  try {
    const created = await BusinessGroup.create({
      name,
      description: String(body.description || "").trim().slice(0, 1000),
      orgId,
      active: body.active === false ? false : true,
    });

    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "group.create",
      success: true,
      target: { groupId: String(created._id), orgId },
    });

    return NextResponse.json({
      success: true,
      group: {
        id: String(created._id),
        name: created.name,
        description: created.description || "",
        orgId: String(created.orgId),
        active: created.active !== false,
      },
    });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      return NextResponse.json(
        {
          success: false,
          code: "duplicate_name",
          message: "A group with this name already exists in the organization.",
        },
        { status: 409 }
      );
    }
    throw err;
  }
}
