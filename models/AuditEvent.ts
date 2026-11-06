import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Durable audit history (append-oriented).
 * Never store passwords, tokens, or full reply bodies.
 * Schema/indexes defined in source only — do not auto-create on live DB from app.
 */
const auditEventSchema = new Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    actorRole: { type: String, default: null },
    action: { type: String, required: true, index: true },
    success: { type: Boolean, default: true },
    code: { type: String, default: "" },
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", default: null, index: true },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      default: null,
      index: true,
    },
    /** Safe metadata only (ids, statuses, counts). */
    target: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: false }
);

auditEventSchema.index({ businessId: 1, at: -1 });
auditEventSchema.index({ action: 1, at: -1 });

export type AuditEventDocument = InferSchemaType<typeof auditEventSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const AuditEvent: Model<AuditEventDocument> =
  mongoose.models.AuditEvent ||
  mongoose.model<AuditEventDocument>("AuditEvent", auditEventSchema);
