import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import {
  checkDraftRateLimit,
  checkSaUnassignedDraftRateLimit,
} from "@/lib/ai/rateLimit";
import { generateReplyDraft, ReplyDraftError } from "@/lib/ai/replyDraft";
import { isOpenAiConfigured } from "@/lib/ai/openaiConfig";
import {
  assertLifecycleAllowsAction,
  operationalGuardResponse,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import {
  assertUserCanAccessReview,
  isOrgUserResult,
  requireOrgAndUserAccess,
} from "@/lib/auth/googleRouteAuth";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  EntitlementError,
  entitlementErrorResponse,
  releaseAiDraftQuota,
  tryReserveAiDraftQuota,
} from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Review } from "@/models/Review";
import {
  LOCATION_UNASSIGNED_CODE,
  LOCATION_UNASSIGNED_MESSAGE,
  resolveReviewBusinessId,
} from "@/lib/reviews/resolveReviewBusiness";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ reviewId: string }> };

/**
 * Generate an AI reply draft for a stored review.
 * Persists draftText when not overwriting an approved draft.
 * Does not publish and does not enqueue auto-publish.
 */
export async function POST(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const access = await requireOrgAndUserAccess();
  if (!isOrgUserResult(access)) return access.response;

  if (!isOpenAiConfigured()) {
    return NextResponse.json(
      {
        success: false,
        code: "not_configured",
        message:
          "OpenAI is not configured on the server. Set OPENAI_API_KEY in .env.local.",
      },
      { status: 503 }
    );
  }

  const rate = checkDraftRateLimit(access.orgId);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        success: false,
        code: "rate_limited",
        message: `Too many draft requests. Try again in about ${rate.retryAfterSec}s.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSec) },
      }
    );
  }

  const { reviewId } = await context.params;
  if (!mongoose.isValidObjectId(reviewId)) {
    return NextResponse.json(
      {
        success: false,
        code: "invalid_id",
        message: "Invalid review id.",
      },
      { status: 400 }
    );
  }

  let forceRegenerate = false;
  try {
    const body = (await request.json()) as { forceRegenerate?: unknown };
    forceRegenerate = body.forceRegenerate === true;
  } catch {
    // empty body ok
  }

  const reviewAccess = await assertUserCanAccessReview({
    user: access.user,
    orgId: access.orgId,
    reviewId,
  });
  if (!reviewAccess.ok) return reviewAccess.response;

  try {
    await connectToDatabase();

    const review = await Review.findOne({
      _id: reviewId,
      orgId: access.orgId,
    })
      .select(
        "starRating comment reviewerDisplayName businessId draftStatus draftApproved draftText"
      )
      .lean();

    if (!review) {
      return NextResponse.json(
        {
          success: false,
          code: "not_found",
          message: "Review not found for this organization.",
        },
        { status: 404 }
      );
    }

    if (review.draftApproved && review.draftStatus === "approved" && !forceRegenerate) {
      return NextResponse.json(
        {
          success: false,
          code: "draft_approved",
          message:
            "An approved draft already exists. Pass forceRegenerate=true to replace it, or edit/publish the existing draft.",
          draft: review.draftText || "",
        },
        { status: 409 }
      );
    }

    let brandVoice = "friendly";
    let preferredLanguage = "English";
    let replyToneNotes = "";
    const resolved = await resolveReviewBusinessId({
      reviewId,
      orgId: access.orgId,
      heal: true,
    });
    const businessId = resolved.ok ? resolved.businessId : null;
    if (businessId) {
      const business = await Business.findById(businessId)
        .select("brandVoice preferredLanguage replyToneNotes active status")
        .lean();
      if (!business) {
        return NextResponse.json(
          { success: false, code: "not_found", message: "Business not found." },
          { status: 404 }
        );
      }
      try {
        assertLifecycleAllowsAction(business, "draft");
      } catch (err) {
        if (err instanceof OperationalGuardError) {
          return operationalGuardResponse(err);
        }
        throw err;
      }
      brandVoice = business.brandVoice || brandVoice;
      preferredLanguage = business.preferredLanguage || preferredLanguage;
      replyToneNotes = String(business.replyToneNotes || "");
      await tryReserveAiDraftQuota(businessId);
    } else if (access.user.role !== "superadmin") {
      return NextResponse.json(
        {
          success: false,
          code:
            resolved.ok === false && resolved.code === LOCATION_UNASSIGNED_CODE
              ? LOCATION_UNASSIGNED_CODE
              : "no_business",
          message:
            resolved.ok === false
              ? resolved.message
              : LOCATION_UNASSIGNED_MESSAGE,
        },
        { status: 409 }
      );
    } else {
      const saLimit = checkSaUnassignedDraftRateLimit(access.user.userId);
      if (!saLimit.allowed) {
        return NextResponse.json(
          {
            success: false,
            code: "rate_limited",
            message: `Unassigned Super Admin drafts are capped. Assign the location to a business or retry in about ${saLimit.retryAfterSec}s.`,
          },
          {
            status: 429,
            headers: { "Retry-After": String(saLimit.retryAfterSec) },
          }
        );
      }
    }

    try {
      const result = await generateReplyDraft({
        starRating:
          typeof review.starRating === "number" ? review.starRating : null,
        comment: review.comment || "",
        reviewerDisplayName: review.reviewerDisplayName || "",
        brandVoice,
        preferredLanguage,
        replyToneNotes,
      });

      const now = new Date();
      await Review.updateOne(
        { _id: reviewId, orgId: access.orgId },
        {
          $set: {
            draftText: result.draft,
            draftStatus: "generated",
            draftApproved: false,
            draftGeneratedAt: now,
            draftUpdatedAt: now,
          },
        }
      );

      auditLog({
        actorId: access.user.userId,
        actorRole: access.user.role,
        action: "review.draft_generate",
        success: true,
        target: {
          orgId: access.orgId,
          reviewId,
          businessId: businessId || null,
          draftStatus: "generated",
        },
      });

      return NextResponse.json({
        success: true,
        isDraft: true,
        draft: result.draft,
        draftStatus: "generated",
        persisted: true,
        tone: result.tone,
        model: result.model,
        message:
          "AI-generated draft saved. Not sent to Google. Edit and approve before publishing.",
      });
    } catch (genErr) {
      if (businessId) {
        await releaseAiDraftQuota(businessId);
      }
      throw genErr;
    }
  } catch (err) {
    if (err instanceof EntitlementError) {
      return entitlementErrorResponse(err);
    }
    if (err instanceof OperationalGuardError) {
      return operationalGuardResponse(err);
    }
    if (err instanceof ReplyDraftError) {
      return NextResponse.json(
        {
          success: false,
          code: err.code,
          message: err.message,
        },
        { status: err.status }
      );
    }
    console.error(
      "Draft route failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "draft_failed",
        message: "Could not generate a reply draft.",
      },
      { status: 500 }
    );
  }
}

/** Persist owner edits / approval without regenerating. */
export async function PATCH(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const access = await requireOrgAndUserAccess();
  if (!isOrgUserResult(access)) return access.response;

  const { reviewId } = await context.params;
  if (!mongoose.isValidObjectId(reviewId)) {
    return NextResponse.json(
      { success: false, code: "invalid_id", message: "Invalid review id." },
      { status: 400 }
    );
  }

  const reviewAccess = await assertUserCanAccessReview({
    user: access.user,
    orgId: access.orgId,
    reviewId,
  });
  if (!reviewAccess.ok) return reviewAccess.response;

  let body: { draftText?: unknown; approve?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const review = await Review.findOne({ _id: reviewId, orgId: access.orgId })
    .select("businessId draftText")
    .lean();
  if (!review) {
    return NextResponse.json(
      { success: false, code: "not_found", message: "Review not found." },
      { status: 404 }
    );
  }

  const resolved = await resolveReviewBusinessId({
    reviewId,
    orgId: access.orgId,
    heal: true,
  });
  const businessId = resolved.ok ? resolved.businessId : null;

  if (businessId) {
    const business = await Business.findById(businessId)
      .select("active status")
      .lean();
    if (business) {
      try {
        assertLifecycleAllowsAction(business, "draft");
      } catch (err) {
        if (err instanceof OperationalGuardError) {
          return operationalGuardResponse(err);
        }
        throw err;
      }
    }
  }

  const draftText =
    typeof body.draftText === "string"
      ? body.draftText
      : review.draftText || "";
  const approve = body.approve === true;
  const now = new Date();

  await Review.updateOne(
    { _id: reviewId, orgId: access.orgId },
    {
      $set: {
        draftText,
        draftStatus: approve ? "approved" : "edited",
        draftApproved: approve,
        draftUpdatedAt: now,
      },
    }
  );

  auditLog({
    actorId: access.user.userId,
    actorRole: access.user.role,
    action: approve ? "review.draft_approve" : "review.draft_save",
    success: true,
    target: {
      orgId: access.orgId,
      reviewId,
      businessId,
      draftStatus: approve ? "approved" : "edited",
    },
  });

  return NextResponse.json({
    success: true,
    draft: draftText,
    draftStatus: approve ? "approved" : "edited",
    draftApproved: approve,
    message: approve
      ? "Draft approved locally. Publishing still requires an explicit publish action."
      : "Draft saved. Not sent to Google.",
  });
}
