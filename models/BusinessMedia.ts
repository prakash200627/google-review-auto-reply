import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Outlet media stored in Cloudinary (TRONX asset library).
 * Does NOT automatically update Google Business Profile photos.
 */
export const MEDIA_PURPOSES = ["internal", "gbp_candidate"] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

const businessMediaSchema = new Schema(
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
    purpose: {
      type: String,
      enum: MEDIA_PURPOSES,
      default: "internal",
      index: true,
    },
    cloudinaryPublicId: { type: String, required: true },
    secureUrl: { type: String, required: true },
    mimeType: { type: String, default: "" },
    bytes: { type: Number, default: 0 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    originalFilename: { type: String, default: "" },
    uploadedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

businessMediaSchema.index({ businessId: 1, createdAt: -1 });

export type BusinessMediaDocument = InferSchemaType<
  typeof businessMediaSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const BusinessMedia: Model<BusinessMediaDocument> =
  mongoose.models.BusinessMedia ||
  mongoose.model<BusinessMediaDocument>("BusinessMedia", businessMediaSchema);
