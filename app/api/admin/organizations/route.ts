import { NextResponse } from "next/server";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { connectToDatabase } from "@/lib/mongodb";
import { Organization } from "@/models/Organization";
import { readOrganizationId } from "@/lib/org/session";

export const runtime = "nodejs";

/** List organizations for Super Admin workspace selection (minimal fields). */
export async function GET() {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  await connectToDatabase();
  const [orgs, activeOrgId] = await Promise.all([
    Organization.find({})
      .select("name email mode createdAt")
      .sort({ createdAt: -1 })
      .lean(),
    readOrganizationId(),
  ]);

  return NextResponse.json({
    success: true,
    activeOrgId,
    organizations: orgs.map((o) => ({
      id: String(o._id),
      name: o.name || "",
      email: o.email || "",
      mode: o.mode || "manual",
      createdAt: o.createdAt,
    })),
  });
}
