import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const FAKE_REVIEW_FLAG_STATUSES = [
  "open",
  "investigating",
  "dismissed",
  "confirmed_suspicious",
] as const;

/**
 * Staff investigation flag — never an automatic fraud declaration.
 * Does not submit reports to Google.
 */
const fakeReviewFlagSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    reviewId: {
      type: Schema.Types.ObjectId,
      ref: "Review",
      required: true,
      index: true,
    },
    reason: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: FAKE_REVIEW_FLAG_STATUSES,
      default: "open",
      index: true,
    },
    /** Internal staff notes — not returned on owner-facing endpoints. */
    staffNotes: { type: String, default: "" },
    flaggedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

fakeReviewFlagSchema.index({ reviewId: 1, status: 1 });

export type FakeReviewFlagDocument = InferSchemaType<
  typeof fakeReviewFlagSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const FakeReviewFlag: Model<FakeReviewFlagDocument> =
  mongoose.models.FakeReviewFlag ||
  mongoose.model<FakeReviewFlagDocument>("FakeReviewFlag", fakeReviewFlagSchema);
