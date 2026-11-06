import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/** Manual ranking observation entered by TRONX staff (not automated crawl). */
const seoRankingSchema = new Schema(
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
    keywordId: {
      type: Schema.Types.ObjectId,
      ref: "SeoKeyword",
      required: true,
      index: true,
    },
    position: { type: Number, required: true },
    observedAt: { type: Date, required: true, index: true },
    notes: { type: String, default: "" },
    recordedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

seoRankingSchema.index({ keywordId: 1, observedAt: -1 });

export type SeoRankingDocument = InferSchemaType<typeof seoRankingSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const SeoRanking: Model<SeoRankingDocument> =
  mongoose.models.SeoRanking ||
  mongoose.model<SeoRankingDocument>("SeoRanking", seoRankingSchema);
