import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";

/** Location has no explicit Business assignment (source of truth). */
export const LOCATION_UNASSIGNED_CODE = "location_unassigned" as const;

export const LOCATION_UNASSIGNED_MESSAGE =
  "This review's Google location is not assigned to a business. A Super Admin must assign the location under Admin → Businesses before this action can continue.";

/**
 * Prefer the review's stored businessId; if absent, use the location's
 * explicit assignment. Never invents a business from org or Google ids.
 */
export function pickBusinessIdFromAssignment(
  reviewBusinessId: unknown,
  locationBusinessId: unknown
): string | null {
  if (
    reviewBusinessId &&
    mongoose.isValidObjectId(String(reviewBusinessId))
  ) {
    return String(reviewBusinessId);
  }
  if (
    locationBusinessId &&
    mongoose.isValidObjectId(String(locationBusinessId))
  ) {
    return String(locationBusinessId);
  }
  return null;
}

export type ResolveReviewBusinessSuccess = {
  ok: true;
  businessId: string;
  source: "review" | "location";
  reviewId: string;
  locationId: string;
  /** True when Review.businessId was null and was written from Location. */
  healed: boolean;
};

export type ResolveReviewBusinessFailure = {
  ok: false;
  code:
    | "invalid_id"
    | "not_found"
    | "location_missing"
    | typeof LOCATION_UNASSIGNED_CODE;
  message: string;
  reviewId?: string;
  locationId?: string;
};

export type ResolveReviewBusinessResult =
  | ResolveReviewBusinessSuccess
  | ResolveReviewBusinessFailure;

/**
 * Resolve the business linked to a review via Review.businessId or, when
 * absent, Location.businessId (explicit Super Admin assignment only).
 *
 * When `heal` is true and the location is assigned but the review row is
 * stale (null businessId), persist Location.businessId onto the review.
 */
export async function resolveReviewBusinessId(input: {
  reviewId: string;
  orgId: string;
  heal?: boolean;
}): Promise<ResolveReviewBusinessResult> {
  const { reviewId, orgId, heal = false } = input;

  if (
    !mongoose.isValidObjectId(reviewId) ||
    !mongoose.isValidObjectId(orgId)
  ) {
    return {
      ok: false,
      code: "invalid_id",
      message: "Invalid review or organization id.",
    };
  }

  await connectToDatabase();

  const review = await Review.findOne({ _id: reviewId, orgId })
    .select("businessId locationId")
    .lean();

  if (!review) {
    return {
      ok: false,
      code: "not_found",
      message: "Review not found for this organization.",
      reviewId,
    };
  }

  const locationId = review.locationId ? String(review.locationId) : "";
  if (!locationId || !mongoose.isValidObjectId(locationId)) {
    return {
      ok: false,
      code: "location_missing",
      message: "Review is missing a valid location link.",
      reviewId,
    };
  }

  const location = await Location.findOne({ _id: locationId, orgId })
    .select("businessId")
    .lean();

  if (!location) {
    return {
      ok: false,
      code: "location_missing",
      message: "Location not found for this organization.",
      reviewId,
      locationId,
    };
  }

  const fromReview = review.businessId ? String(review.businessId) : null;
  const fromLocation = location.businessId
    ? String(location.businessId)
    : null;
  const businessId = pickBusinessIdFromAssignment(fromReview, fromLocation);

  if (!businessId) {
    return {
      ok: false,
      code: LOCATION_UNASSIGNED_CODE,
      message: LOCATION_UNASSIGNED_MESSAGE,
      reviewId,
      locationId,
    };
  }

  let healed = false;
  const source: "review" | "location" = fromReview ? "review" : "location";

  if (heal && !fromReview && fromLocation) {
    await Review.updateOne(
      { _id: reviewId, orgId, businessId: null },
      { $set: { businessId: fromLocation } }
    );
    healed = true;
  }

  return {
    ok: true,
    businessId,
    source,
    reviewId,
    locationId,
    healed,
  };
}
