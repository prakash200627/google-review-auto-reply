import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/** Staff-managed SEO keyword for a business (Local/Geographic SEO). */
const seoKeywordSchema = new Schema(
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
    keyword: { type: String, required: true, trim: true },
    targetLocation: { type: String, default: "", trim: true },
    notes: { type: String, default: "" },
    active: { type: Boolean, default: true },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

seoKeywordSchema.index({ businessId: 1, keyword: 1, targetLocation: 1 });

export type SeoKeywordDocument = InferSchemaType<typeof seoKeywordSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const SeoKeyword: Model<SeoKeywordDocument> =
  mongoose.models.SeoKeyword ||
  mongoose.model<SeoKeywordDocument>("SeoKeyword", seoKeywordSchema);
