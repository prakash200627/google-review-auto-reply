import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { AutoPublishJob } from "@/models/AutoPublishJob";
import { Business } from "@/models/Business";
import { Review } from "@/models/Review";
import {
  assertAutoPublishAuthorized,
  classifyAutoPublishRisk,
  normalizeAutoPublishConfig,
  AutoPublishPolicyError,
} from "@/lib/autoPublish/policy";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";

export function buildIdempotencyKey(businessId: string, reviewId: string): string {
  return `autopub:${businessId}:${reviewId}`;
}

/**
 * Enqueue a review for automatic publishing after policy + risk checks.
 * Does not call Google or OpenAI. Idempotent per business+review.
 */
export async function enqueueAutoPublishJob(input: {
  businessId: string;
  reviewId: string;
  draftText: string;
}): Promise<{
  jobId: string;
  status: string;
  riskReason?: string;
}> {
  const { businessId, reviewId, draftText } = input;
  if (
    !mongoose.isValidObjectId(businessId) ||
    !mongoose.isValidObjectId(reviewId)
  ) {
    throw new AutoPublishPolicyError("Invalid business or review id.", {
      code: "invalid_id",
    });
  }

  const comment = String(draftText || "").trim();
  if (!comment) {
    throw new AutoPublishPolicyError("Draft text is required to enqueue.", {
      code: "invalid_draft",
    });
  }

  await connectToDatabase();
  const business = await Business.findById(businessId)
    .select("orgId replyMode plan autoPublish active status locationIds")
    .lean();
  if (!business) {
    throw new AutoPublishPolicyError("Business not found or inactive.", {
      code: "business_unavailable",
    });
  }
  const { lifecycleAllowsAutoPublish } = await import("@/lib/business/lifecycle");
  if (!lifecycleAllowsAutoPublish(business)) {
    throw new AutoPublishPolicyError("Business not found or inactive.", {
      code: "business_unavailable",
    });
  }

  const plan = toPlanSnapshot(business.plan as never);
  const autoPublish = normalizeAutoPublishConfig(
    business.autoPublish as never
  );
  assertAutoPublishAuthorized({
    replyMode: business.replyMode,
    autoPublish,
    planStatus: plan.status,
    planFeatures: plan.features,
  });

  const review = await Review.findOne({
    _id: reviewId,
    businessId,
    orgId: business.orgId,
  })
    .select("starRating comment locationId replyComment")
    .lean();
  if (!review) {
    throw new AutoPublishPolicyError(
      "Review not found for this business.",
      { code: "review_not_found" }
    );
  }
  if ((review.replyComment || "").trim()) {
    throw new AutoPublishPolicyError(
      "Review already has a published reply; refusing duplicate auto-publish.",
      { code: "already_replied" }
    );
  }

  const risk = classifyAutoPublishRisk({
    starRating:
      typeof review.starRating === "number" ? review.starRating : null,
    maxAutoStarRatingExclusive: autoPublish.maxAutoStarRatingExclusive,
    comment: review.comment,
  });

  const idempotencyKey = buildIdempotencyKey(businessId, reviewId);
  const publishAfter = new Date(
    Date.now() + autoPublish.publishDelayMinutes * 60_000
  );
  const status = risk.ok ? "queued_auto_publish" : "awaiting_approval";

  const job = await AutoPublishJob.findOneAndUpdate(
    { idempotencyKey },
    {
      $setOnInsert: {
        orgId: business.orgId,
        businessId,
        locationId: review.locationId,
        reviewId,
        idempotencyKey,
        attempts: 0,
        maxAttempts: 3,
      },
      $set: {
        status,
        draftText: comment,
        publishAfter: risk.ok ? publishAfter : null,
        riskReason: risk.ok ? "" : risk.reason,
        lastError: "",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  return {
    jobId: String(job!._id),
    status,
    ...(risk.ok ? {} : { riskReason: risk.reason }),
  };
}
