import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const reviewSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    /**
     * Optional multi-business association. Legacy rows stay null until
     * explicitly assigned via Super Admin location → business mapping.
     */
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      default: null,
      index: true,
    },
    locationId: {
      type: Schema.Types.ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },
    /** accounts/.../locations/.../reviews/{reviewId} */
    googleReviewName: { type: String, required: true },
    googleReviewId: { type: String, required: true },
    reviewerDisplayName: { type: String, default: "" },
    reviewerIsAnonymous: { type: Boolean, default: false },
    starRating: { type: Number, default: null },
    comment: { type: String, default: "" },
    createTime: { type: Date, default: null },
    updateTime: { type: Date, default: null },
    /**
     * Last known owner/manager reply text on Google (synced or TRONX-published).
     * Do not treat a non-empty value alone as a TRONX publication — see
     * `replySource` / `tronxPublishedAt`.
     */
    replyComment: { type: String, default: "" },
    replyUpdateTime: { type: Date, default: null },
    replyState: { type: String, default: "" },
    /**
     * Provenance of the current replyComment:
     * - google_synced: observed on Google during sync (not a TRONX publish)
     * - tronx_published: confirmed after TRONX publish API success
     * - unknown: legacy rows before provenance tracking
     */
    replySource: {
      type: String,
      enum: ["google_synced", "tronx_published", "unknown", ""],
      default: "unknown",
      index: true,
    },
    /** Set only after TRONX confirms Google publish success. */
    tronxPublishedAt: { type: Date, default: null },
    lastPublishError: { type: String, default: "" },
    /** Durable AI/manual draft awaiting approval — not published. */
    draftText: { type: String, default: "" },
    draftStatus: {
      type: String,
      enum: ["none", "generated", "edited", "approved", "rejected", ""],
      default: "none",
      index: true,
    },
    draftApproved: { type: Boolean, default: false },
    draftUpdatedAt: { type: Date, default: null },
    draftGeneratedAt: { type: Date, default: null },
    /** Multi-instance publish lock — set only while a Google write is in flight. */
    publishClaimOwner: { type: String, default: null },
    publishClaimExpiresAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

reviewSchema.index({ orgId: 1, googleReviewName: 1 }, { unique: true });
reviewSchema.index({ locationId: 1, updateTime: -1 });
/** Inbox / owner-scoped lists: businessId $in + sort by updateTime. */
reviewSchema.index({ businessId: 1, updateTime: -1 });

export type ReviewDocument = InferSchemaType<typeof reviewSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Review: Model<ReviewDocument> =
  mongoose.models.Review ||
  mongoose.model<ReviewDocument>("Review", reviewSchema);
