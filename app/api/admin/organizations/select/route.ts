import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { connectToDatabase } from "@/lib/mongodb";
import { Organization } from "@/models/Organization";
import { applySelectedOrganizationCookie } from "@/lib/org/session";

export const runtime = "nodejs";

/**
 * Explicit Super Admin organization switch.
 * Verifies the org exists, then sets a server-signed cookie on the response.
 * Does not accept forged cookies or unsigned ObjectIds from the client.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  let orgId = "";
  try {
    const body = (await request.json()) as { orgId?: unknown };
    orgId = String(body.orgId || "").trim();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  if (!mongoose.isValidObjectId(orgId)) {
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "org.select",
      success: false,
      code: "invalid_id",
      target: { orgId },
    });
    return NextResponse.json(
      { success: false, code: "invalid_id", message: "Invalid organization id." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const found = await Organization.findById(orgId).select("_id name").lean();
  if (!found) {
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "org.select",
      success: false,
      code: "not_found",
      target: { orgId },
    });
    return NextResponse.json(
      {
        success: false,
        code: "not_found",
        message: "Organization not found.",
      },
      { status: 404 }
    );
  }

  const response = NextResponse.json({
    success: true,
    orgId: String(found._id),
    name: found.name || "",
    message: "Active Google workspace organization updated.",
  });
  applySelectedOrganizationCookie(response, String(found._id));
  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "org.select",
    success: true,
    target: { orgId: String(found._id) },
  });
  return response;
}
