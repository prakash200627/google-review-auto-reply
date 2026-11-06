import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Durable ops signal for audit Mongo persistence failures.
 * Singleton document (_id fixed). Never stores audit payloads or secrets.
 * Writing here must never call auditLog (avoid recursion).
 */
export const AUDIT_PERSIST_HEALTH_ID = "audit_persist";

const auditPersistHealthSchema = new Schema(
  {
    _id: { type: String, required: true },
    failureCount: { type: Number, default: 0 },
    lastFailureAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: "" },
    /** Last action name that failed to persist (safe identifier only). */
    lastAction: { type: String, default: "" },
    alertArmed: { type: Boolean, default: false },
    lastAlertAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export type AuditPersistHealthDocument = InferSchemaType<
  typeof auditPersistHealthSchema
> & {
  _id: string;
};

export const AuditPersistHealth: Model<AuditPersistHealthDocument> =
  mongoose.models.AuditPersistHealth ||
  mongoose.model<AuditPersistHealthDocument>(
    "AuditPersistHealth",
    auditPersistHealthSchema
  );
