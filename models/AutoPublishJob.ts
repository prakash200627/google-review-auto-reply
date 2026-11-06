import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Persistent auto-publish queue. Jobs are never created merely because
 * Business.replyMode === "auto". Creation requires explicit autoPublish
 * enablement, plan entitlement, and global kill-switch checks.
 */
export const AUTO_PUBLISH_STATUSES = [
  "draft_generated",
  "awaiting_approval",
  "queued_auto_publish",
  "processing",
  "published",
  "failed",
  "skipped_risk",
  "cancelled",
] as const;

export type AutoPublishStatus = (typeof AUTO_PUBLISH_STATUSES)[number];

/** Default claim lease for a processing worker (ms). */
export const AUTO_PUBLISH_CLAIM_LEASE_MS = 5 * 60 * 1000;

const autoPublishJobSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    locationId: {
      type: Schema.Types.ObjectId,
      ref: "Location",
      required: true,
    },
    reviewId: {
      type: Schema.Types.ObjectId,
      ref: "Review",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: AUTO_PUBLISH_STATUSES,
      default: "queued_auto_publish",
      index: true,
    },
    draftText: { type: String, default: "" },
    publishAfter: { type: Date, default: null, index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lastError: { type: String, default: "" },
    riskReason: { type: String, default: "" },
    idempotencyKey: { type: String, required: true, unique: true },
    publishedAt: { type: Date, default: null },
    /** Worker identity that currently owns a processing claim. */
    claimOwner: { type: String, default: null },
    /** Claim expires at — stale processing jobs become reclaimable. */
    claimExpiresAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

autoPublishJobSchema.index({ status: 1, publishAfter: 1 });
autoPublishJobSchema.index({ businessId: 1, reviewId: 1 });
autoPublishJobSchema.index({ status: 1, claimExpiresAt: 1 });

export type AutoPublishJobDocument = InferSchemaType<
  typeof autoPublishJobSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const AutoPublishJob: Model<AutoPublishJobDocument> =
  mongoose.models.AutoPublishJob ||
  mongoose.model<AutoPublishJobDocument>("AutoPublishJob", autoPublishJobSchema);
