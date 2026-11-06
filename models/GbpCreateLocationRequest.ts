import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Idempotency ledger for Super Admin GBP location creation.
 * requestId is also sent to Google (accounts.locations.create) for server-side
 * duplicate detection. Never stores tokens or full address payloads.
 *
 * Status lifecycle:
 * - pending: Google create not confirmed yet
 * - google_created: Google accepted create; local Location not yet persisted
 * - succeeded: local Location upserted
 * - failed: Google create (or pre-Google validation) failed — safe to retry
 *   Google with the same requestId only after careful review; prefer new attempt
 *   for true Google failures. Never clear google_* fields when status is
 *   google_created.
 */
const gbpCreateLocationRequestSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    /** Client-supplied idempotency key (UUID recommended; max 50 chars for Google). */
    requestId: { type: String, required: true },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    googleAccountName: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "google_created", "succeeded", "failed"],
      required: true,
      default: "pending",
    },
    locationId: {
      type: Schema.Types.ObjectId,
      ref: "Location",
      default: null,
    },
    googleLocationName: { type: String, default: "" },
    businessInfoName: { type: String, default: "" },
    /** Safe metadata for reconciliation (no secrets). */
    createdTitle: { type: String, default: "" },
    createdStoreCode: { type: String, default: "" },
    createdAddress: { type: String, default: "" },
    createdPlaceId: { type: String, default: "" },
    errorCode: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
  },
  { timestamps: true }
);

gbpCreateLocationRequestSchema.index(
  { orgId: 1, requestId: 1 },
  { unique: true }
);

export type GbpCreateLocationRequestDocument = InferSchemaType<
  typeof gbpCreateLocationRequestSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const GbpCreateLocationRequest: Model<GbpCreateLocationRequestDocument> =
  mongoose.models.GbpCreateLocationRequest ||
  mongoose.model<GbpCreateLocationRequestDocument>(
    "GbpCreateLocationRequest",
    gbpCreateLocationRequestSchema
  );
