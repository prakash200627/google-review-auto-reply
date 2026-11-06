/**
 * Safe one-star handling after review sync.
 * - Creates an internal FakeReviewFlag escalation (idempotent).
 * - Never publishes a reply.
 * - Never reports to Google.
 * - Does not call OpenAI (drafts remain on-demand / entitled).
 */

import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { FakeReviewFlag } from "@/models/FakeReviewFlag";
import { Location } from "@/models/Location";
import { classifyAutoPublishRisk } from "@/lib/autoPublish/policy";
import { pickBusinessIdFromAssignment } from "@/lib/reviews/resolveReviewBusiness";

export type OneStarEscalationResult = {
  reviewId: string;
  starRating: number | null;
  escalated: boolean;
  flagCreated: boolean;
  riskReason: string | null;
  published: false;
  reportedToGoogle: false;
};

export async function escalateOneStarReview(input: {
  reviewId: string;
  businessId: string | null | undefined;
  /** Used when businessId is null — resolve from Location.businessId only. */
  locationId?: string | null;
  orgId: string;
  starRating: number | null;
  comment?: string | null;
}): Promise<OneStarEscalationResult> {
  const base: OneStarEscalationResult = {
    reviewId: input.reviewId,
    starRating: input.starRating,
    escalated: false,
    flagCreated: false,
    riskReason: null,
    published: false,
    reportedToGoogle: false,
  };

  if (
    !mongoose.isValidObjectId(input.reviewId) ||
    !mongoose.isValidObjectId(input.orgId)
  ) {
    return base;
  }

  // Only exact 1★ auto-escalates; 2★ still blocked from auto-publish via policy.
  if (input.starRating !== 1) {
    return base;
  }

  let businessId = pickBusinessIdFromAssignment(input.businessId, null);

  if (!businessId && input.locationId && mongoose.isValidObjectId(input.locationId)) {
    await connectToDatabase();
    const location = await Location.findOne({
      _id: input.locationId,
      orgId: input.orgId,
    })
      .select("businessId")
      .lean();
    businessId = pickBusinessIdFromAssignment(null, location?.businessId);
  }

  if (!businessId) {
    return { ...base, riskReason: "no_business_assignment" };
  }

  const risk = classifyAutoPublishRisk({
    starRating: input.starRating,
    maxAutoStarRatingExclusive: 3,
    comment: input.comment || "",
  });

  await connectToDatabase();
  const existing = await FakeReviewFlag.findOne({
    reviewId: input.reviewId,
    businessId,
    status: { $in: ["open", "investigating", "confirmed_suspicious"] },
  })
    .select("_id")
    .lean();

  if (existing) {
    return {
      ...base,
      escalated: true,
      flagCreated: false,
      riskReason: risk.ok ? "one_star" : risk.reason,
    };
  }

  await FakeReviewFlag.create({
    businessId,
    orgId: input.orgId,
    reviewId: input.reviewId,
    reason:
      "Automatic escalation: newly synced one-star review (manual review required — no auto-publish).",
    status: "open",
    staffNotes: "",
    flaggedByUserId: null,
  });

  return {
    ...base,
    escalated: true,
    flagCreated: true,
    riskReason: risk.ok ? "one_star" : risk.reason,
  };
}
