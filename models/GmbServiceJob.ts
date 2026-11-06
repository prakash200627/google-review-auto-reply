import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const GMB_JOB_TYPES = [
  "setup",
  "suspension_assistance",
  "recovery_assistance",
  "other",
] as const;

export const GMB_JOB_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_customer",
  "waiting_on_google",
  "completed",
  "cancelled",
] as const;

const gmbServiceJobSchema = new Schema(
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
    type: {
      type: String,
      enum: GMB_JOB_TYPES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: GMB_JOB_STATUSES,
      default: "open",
      index: true,
    },
    title: { type: String, required: true, trim: true },
    checklist: {
      type: [
        {
          label: { type: String, default: "" },
          done: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
    /** Internal staff notes — not shown to owners by default. */
    staffNotes: { type: String, default: "" },
    /** Owner-visible status summary. */
    ownerSummary: { type: String, default: "" },
    assignedStaffUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

gmbServiceJobSchema.index({ businessId: 1, updatedAt: -1 });

export type GmbServiceJobDocument = InferSchemaType<typeof gmbServiceJobSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const GmbServiceJob: Model<GmbServiceJobDocument> =
  mongoose.models.GmbServiceJob ||
  mongoose.model<GmbServiceJobDocument>("GmbServiceJob", gmbServiceJobSchema);
