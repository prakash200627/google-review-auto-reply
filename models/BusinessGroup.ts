import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Internal TRONX business group (not a Google entity, not Organization).
 * Super Admin owns groups; Business Admins are assigned via User.groupIds.
 * A Business belongs to at most one group (Business.groupId).
 */
const businessGroupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 1000 },
    /**
     * Google OAuth workspace this group's businesses operate under.
     * Locations remain org-scoped; groups never invent Google ownership.
     */
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

businessGroupSchema.index({ orgId: 1, name: 1 }, { unique: true });

export type BusinessGroupDocument = InferSchemaType<
  typeof businessGroupSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const BusinessGroup: Model<BusinessGroupDocument> =
  mongoose.models.BusinessGroup ||
  mongoose.model<BusinessGroupDocument>("BusinessGroup", businessGroupSchema);
