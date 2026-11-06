import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import {
  assertBusinessAccess,
  isAuthUser,
  requireSuperAdmin,
} from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  executePermanentDelete,
  PermanentDeleteError,
  previewPermanentDelete,
} from "@/lib/business/permanentDelete";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

/** Impact preview for the Super Admin confirmation dialog. */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, code: "invalid_business_id", message: "Invalid business id." },
      { status: 400 }
    );
  }

  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  try {
    const preview = await previewPermanentDelete(businessId);
    return NextResponse.json({ success: true, preview });
  } catch (err) {
    if (err instanceof PermanentDeleteError) {
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
      );
    }
    console.error(
      "Permanent delete preview failed:",
      err instanceof Error ? err.message : "unknown"
    );
    return NextResponse.json(
      { success: false, message: "Could not load deletion preview." },
      { status: 500 }
    );
  }
}

/**
 * Execute permanent deletion. UI confirmation is never sufficient — Super Admin
 * session + exact name + second confirmation + phrase are required server-side.
 */
export async function POST(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, code: "invalid_business_id", message: "Invalid business id." },
      { status: 400 }
    );
  }

  // Tenant isolation: SA must still resolve the business via assertBusinessAccess
  // before any cascade. Do not accept client-supplied related ids.
  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  let body: {
    confirmName?: unknown;
    confirmPermanentDelete?: unknown;
    confirmPhrase?: unknown;
    resume?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const actor = {
    actorId: auth.user.userId,
    actorRole: auth.user.role,
  };

  try {
    const result = await executePermanentDelete({
      businessId,
      confirmName: body.confirmName,
      confirmPermanentDelete: body.confirmPermanentDelete,
      confirmPhrase: body.confirmPhrase,
      resume: body.resume === true,
      actor,
    });

    return NextResponse.json({
      success: true,
      alreadyDeleted: result.alreadyDeleted,
      result,
      message: result.alreadyDeleted
        ? "Business was already permanently deleted."
        : `Permanently deleted business "${result.name}".`,
    });
  } catch (err) {
    if (err instanceof PermanentDeleteError) {
      if (err.code === "forbidden") {
        auditLog({
          ...actor,
          action: "business.permanent_delete",
          success: false,
          code: err.code,
          target: { businessId },
        });
      }
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
      );
    }
    auditLog({
      ...actor,
      action: "business.permanent_delete",
      success: false,
      code: "delete_failed",
      target: { businessId },
    });
    console.error(
      "Permanent delete failed:",
      err instanceof Error ? err.message : "unknown"
    );
    return NextResponse.json(
      { success: false, message: "Could not permanently delete business." },
      { status: 500 }
    );
  }
}
