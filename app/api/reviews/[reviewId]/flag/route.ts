import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import {
  assertBusinessAccess,
  isAuthUser,
  requireAuthUser,
  requireSuperAdmin,
} from "@/lib/auth/authorize";
import {
  assertUserCanAccessReview,
  isOrgUserResult,
  requireOrgAndUserAccess,
} from "@/lib/auth/googleRouteAuth";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { featureEnabled } from "@/lib/entitlements/featureMap";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import {
  FakeReviewFlag,
  FAKE_REVIEW_FLAG_STATUSES,
} from "@/models/FakeReviewFlag";
import { Review } from "@/models/Review";
import {
  LOCATION_UNASSIGNED_CODE,
  resolveReviewBusinessId,
} from "@/lib/reviews/resolveReviewBusiness";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ reviewId: string }> };

/**
 * Flag a review for staff investigation (not an automatic fraud declaration).
 * Does not submit reports to Google.
 */
export async function POST(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const access = await requireOrgAndUserAccess();
  if (!isOrgUserResult(access)) return access.response;

  const { reviewId } = await context.params;
  if (!mongoose.isValidObjectId(reviewId)) {
    return NextResponse.json(
      { success: false, message: "Invalid review id." },
      { status: 400 }
    );
  }

  const reviewAccess = await assertUserCanAccessReview({
    user: access.user,
    orgId: access.orgId,
    reviewId,
  });
  if (!reviewAccess.ok) return reviewAccess.response;

  let body: { reason?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }
  const reason = String(body.reason || "").trim();
  if (reason.length < 3) {
    return NextResponse.json(
      { success: false, message: "A short reason is required." },
      { status: 400 }
    );
  }

  const resolved = await resolveReviewBusinessId({
    reviewId,
    orgId: access.orgId,
    heal: true,
  });

  if (!resolved.ok) {
    const status =
      resolved.code === "not_found" || resolved.code === "location_missing"
        ? 404
        : resolved.code === LOCATION_UNASSIGNED_CODE
          ? 409
          : 400;
    return NextResponse.json(
      {
        success: false,
        code: resolved.code,
        message: resolved.message,
      },
      { status }
    );
  }

  const businessId = resolved.businessId;
  const bizAccess = await assertBusinessAccess(access.user, businessId);
  if (!bizAccess.ok) return bizAccess.response;

  const plan = toPlanSnapshot(bizAccess.business.plan as never);
  if (!featureEnabled(plan, "fakeReviewFlagging")) {
    return NextResponse.json(
      {
        success: false,
        code: "entitlement_required",
        message:
          "Fake-review flagging requires advanced analytics on this plan.",
      },
      { status: 403 }
    );
  }

  const doc = await FakeReviewFlag.create({
    businessId,
    orgId: access.orgId,
    reviewId,
    reason: reason.slice(0, 1000),
    status: "open",
    flaggedByUserId: access.user.userId,
  });

  auditLog({
    actorId: access.user.userId,
    actorRole: access.user.role,
    action: "fake_review.flag",
    success: true,
    target: {
      businessId,
      orgId: access.orgId,
      reviewId,
      flagId: String(doc._id),
      businessIdSource: resolved.source,
      healed: resolved.healed,
    },
  });

  return NextResponse.json({
    success: true,
    flag: {
      id: String(doc._id),
      status: doc.status,
      reason: doc.reason,
    },
    message:
      "Flagged for staff investigation. This is not a fraud determination and was not sent to Google.",
  });
}

/** Super Admin updates investigation status / staff notes. */
export async function PATCH(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const { reviewId } = await context.params;
  if (!mongoose.isValidObjectId(reviewId)) {
    return NextResponse.json(
      { success: false, message: "Invalid review id." },
      { status: 400 }
    );
  }

  let body: {
    flagId?: unknown;
    status?: unknown;
    staffNotes?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const flagId = String(body.flagId || "");
  if (!mongoose.isValidObjectId(flagId)) {
    return NextResponse.json(
      { success: false, message: "flagId is required." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const flag = await FakeReviewFlag.findOne({
    _id: flagId,
    reviewId,
  }).exec();
  if (!flag) {
    return NextResponse.json(
      { success: false, message: "Flag not found." },
      { status: 404 }
    );
  }

  if (FAKE_REVIEW_FLAG_STATUSES.includes(body.status as never)) {
    flag.status = body.status as (typeof FAKE_REVIEW_FLAG_STATUSES)[number];
  }
  if (typeof body.staffNotes === "string") {
    flag.staffNotes = body.staffNotes.slice(0, 5000);
  }
  await flag.save();

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "fake_review.update",
    success: true,
    target: {
      businessId: String(flag.businessId),
      orgId: String(flag.orgId),
      reviewId,
      flagId: String(flag._id),
      status: flag.status,
    },
  });

  return NextResponse.json({
    success: true,
    flag: {
      id: String(flag._id),
      status: flag.status,
      staffNotes: flag.staffNotes,
    },
  });
}

/** Owner-visible flags for a review (no staff notes). */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;

  const { reviewId } = await context.params;
  if (!mongoose.isValidObjectId(reviewId)) {
    return NextResponse.json(
      { success: false, message: "Invalid review id." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const review = await Review.findById(reviewId)
    .select("businessId locationId orgId")
    .lean();
  if (!review) {
    return NextResponse.json(
      { success: false, message: "Review not found." },
      { status: 404 }
    );
  }

  const resolved = await resolveReviewBusinessId({
    reviewId,
    orgId: String(review.orgId),
    heal: true,
  });
  if (!resolved.ok) {
    return NextResponse.json(
      {
        success: false,
        code: resolved.code,
        message: resolved.message,
      },
      {
        status:
          resolved.code === LOCATION_UNASSIGNED_CODE
            ? 409
            : resolved.code === "not_found" ||
                resolved.code === "location_missing"
              ? 404
              : 400,
      }
    );
  }

  const access = await assertBusinessAccess(auth.user, resolved.businessId);
  if (!access.ok) return access.response;

  const flags = await FakeReviewFlag.find({ reviewId })
    .sort({ createdAt: -1 })
    .lean();
  const isAdmin = auth.user.role === "superadmin";

  return NextResponse.json({
    success: true,
    flags: flags.map((f) => ({
      id: String(f._id),
      reason: f.reason,
      status: f.status,
      staffNotes: isAdmin ? f.staffNotes || "" : undefined,
      createdAt: f.createdAt
        ? new Date(f.createdAt as Date).toISOString()
        : null,
    })),
  });
}
