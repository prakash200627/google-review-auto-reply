import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { connectToDatabase } from "@/lib/mongodb";
import { User } from "@/models/User";
import { Business } from "@/models/Business";
import {
  OwnerAccountError,
  resetOwnerPassword,
  setOwnerActive,
  upsertBusinessOwner,
  validateOwnerEmail,
} from "@/lib/business/owners";

export const runtime = "nodejs";

/** List business-owner accounts (never password hashes). */
export async function GET() {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  await connectToDatabase();
  const owners = await User.find({ role: "business_owner" })
    .select("email name active businessIds groupIds createdAt")
    .sort({ email: 1 })
    .lean();

  return NextResponse.json({
    success: true,
    owners: owners.map((o) => ({
      id: String(o._id),
      email: o.email,
      name: o.name || "",
      active: Boolean(o.active),
      businessIds: (o.businessIds || []).map((id) => String(id)),
      groupIds: (o.groupIds || []).map((id) => String(id)),
      createdAt: o.createdAt,
    })),
  });
}

/**
 * Create/attach an owner to a business, or activate/deactivate an owner.
 * Never allows setting role=superadmin.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  let body: {
    action?: unknown;
    businessId?: unknown;
    email?: unknown;
    password?: unknown;
    name?: unknown;
    userId?: unknown;
    active?: unknown;
    newPassword?: unknown;
    reactivateExisting?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const action = String(body.action || "create");
  const actor = { actorId: auth.user.userId, actorRole: auth.user.role };

  try {
    await connectToDatabase();

    // Reject privilege escalation attempts in payload for any action.
    if (
      body &&
      typeof body === "object" &&
      "role" in (body as Record<string, unknown>)
    ) {
      auditLog({
        ...actor,
        action: "owner.role_escalation_attempt",
        success: false,
        code: "forbidden",
      });
      return NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message: "Role cannot be set via this endpoint.",
        },
        { status: 403 }
      );
    }

    if (action === "set_active") {
      const userId = String(body.userId || "");
      if (typeof body.active !== "boolean") {
        return NextResponse.json(
          { success: false, message: "active boolean is required." },
          { status: 400 }
        );
      }
      await setOwnerActive(userId, body.active);
      auditLog({
        ...actor,
        action: body.active ? "owner.activate" : "owner.deactivate",
        success: true,
        target: { userId },
      });
      return NextResponse.json({
        success: true,
        message: body.active ? "Owner activated." : "Owner deactivated.",
      });
    }

    if (action === "reset_password") {
      const userId = String(body.userId || "");
      await resetOwnerPassword({
        userId,
        newPassword: body.newPassword ?? body.password,
      });
      auditLog({
        ...actor,
        action: "owner.reset_password",
        success: true,
        target: { userId },
      });
      return NextResponse.json({
        success: true,
        message:
          "Owner password updated. Share the new password out-of-band; this app does not send email.",
      });
    }

    if (action === "create" || action === "assign") {
      const businessId = String(body.businessId || "");
      const business = await Business.findById(businessId).select("name").lean();
      if (!business) {
        return NextResponse.json(
          { success: false, message: "Business not found." },
          { status: 404 }
        );
      }

      const result = await upsertBusinessOwner({
        email: body.email,
        password: body.password,
        name:
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : business.name,
        businessId,
        requirePassword: true,
        reactivateExisting: body.reactivateExisting === true,
      });

      const email = validateOwnerEmail(body.email);
      auditLog({
        ...actor,
        action: result.created ? "owner.create" : "owner.link",
        success: true,
        target: {
          userId: String(result.userId),
          businessId,
          email,
          passwordSet: result.passwordSet,
        },
      });

      return NextResponse.json(
        {
          success: true,
          owner: {
            id: String(result.userId),
            email,
            created: result.created,
            linkedExisting: result.linkedExisting,
            passwordSet: result.passwordSet,
          },
          message: result.created
            ? "Owner account created and linked. Share the password out-of-band; it is not emailed by this app."
            : "Existing owner linked to the business. Their password was not changed.",
        },
        { status: result.created ? 201 : 200 }
      );
    }

    return NextResponse.json(
      { success: false, message: "Unknown action." },
      { status: 400 }
    );
  } catch (err) {
    if (err instanceof OwnerAccountError) {
      auditLog({
        ...actor,
        action: `owner.${action}`,
        success: false,
        code: err.code,
        target: {
          userId: String(body.userId || ""),
          businessId: String(body.businessId || ""),
        },
      });
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
      );
    }
    console.error(
      "Owner admin action failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      { success: false, message: "Could not update owner account." },
      { status: 500 }
    );
  }
}
