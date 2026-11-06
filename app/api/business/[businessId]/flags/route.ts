import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  assertBusinessAccess,
  isAuthUser,
  requireSuperAdmin,
} from "@/lib/auth/authorize";
import {
  assertBusinessOperationAllowed,
  operationalGuardResponse,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import { connectToDatabase } from "@/lib/mongodb";
import { FakeReviewFlag } from "@/models/FakeReviewFlag";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

/**
 * Super Admin list of fake-review investigation flags for a business.
 * Staff notes included. Owners use per-review flag GET (notes stripped).
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }

  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;
  try {
    await assertBusinessOperationAllowed({
      businessId,
      business: access.business,
      action: "manage_services",
      actorRole: auth.user.role,
    });
  } catch (err) {
    if (err instanceof OperationalGuardError) {
      return operationalGuardResponse(err);
    }
    throw err;
  }

  await connectToDatabase();
  const flags = await FakeReviewFlag.find({ businessId })
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  return NextResponse.json({
    success: true,
    flags: flags.map((f) => ({
      id: String(f._id),
      reviewId: f.reviewId ? String(f.reviewId) : undefined,
      reason: f.reason,
      status: f.status,
      staffNotes: f.staffNotes || "",
      createdAt: f.createdAt
        ? new Date(f.createdAt as Date).toISOString()
        : null,
    })),
  });
}
