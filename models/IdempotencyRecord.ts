import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Durable idempotency ledger for mutating admin operations.
 * Unique on (orgId, operation, scopeId, key). Never stores tokens or secrets.
 *
 * scopeId: empty string for org-wide ops (onboarding); locationId for
 * location-scoped ops (verification start).
 */
export const IDEMPOTENCY_OPERATIONS = [
  "business.onboarding",
  "gbp.verification.start",
] as const;
export type IdempotencyOperation = (typeof IDEMPOTENCY_OPERATIONS)[number];

/** Default retention — Mongo TTL deletes after this many days from expiresAt. */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

const idempotencyRecordSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    operation: {
      type: String,
      enum: IDEMPOTENCY_OPERATIONS,
      required: true,
    },
    /**
     * Resource scope within the org (e.g. locationId). Empty string for
     * org-scoped operations so the unique index stays uniform.
     */
    scopeId: { type: String, required: true, default: "", maxlength: 64 },
    /** High-entropy client key for one logical attempt. */
    key: { type: String, required: true, maxlength: 128 },
    /** Stable hash of the canonical request payload. */
    payloadHash: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "succeeded", "failed"],
      required: true,
      default: "pending",
    },
    /** Serialized successful result (operation-specific). */
    result: { type: Schema.Types.Mixed, default: null },
    errorCode: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

idempotencyRecordSchema.index(
  { orgId: 1, operation: 1, scopeId: 1, key: 1 },
  { unique: true }
);
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type IdempotencyRecordDocument = InferSchemaType<
  typeof idempotencyRecordSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const IdempotencyRecord: Model<IdempotencyRecordDocument> =
  mongoose.models.IdempotencyRecord ||
  mongoose.model<IdempotencyRecordDocument>(
    "IdempotencyRecord",
    idempotencyRecordSchema
  );
