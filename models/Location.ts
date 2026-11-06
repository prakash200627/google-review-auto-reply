import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Persisted GBP verification status.
 * `verified` means Google Voice of Merchant reports hasVoiceOfMerchant=true —
 * not a claim that the listing is publicly visible on Search/Maps.
 * Never set `verified` from location creation alone.
 */
export const LOCATION_VERIFICATION_STATUSES = [
  "unknown",
  "unverified",
  "pending",
  "verified",
  "failed",
] as const;

export type LocationVerificationStatus =
  (typeof LOCATION_VERIFICATION_STATUSES)[number];

const locationSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    /**
     * Optional business assignment. Unassigned locations remain available
     * for Super Admin to map explicitly — never auto-assigned in bulk.
     *
     * Application logic rejects assigning a location that already has a
     * different businessId (see location_already_assigned).
     * DB safeguard: partial unique index `location_businessId_unique_partial`
     * (created via scripts/ensureLocationBusinessIdUniqueIndex.mjs after
     * duplicate diagnostics). Do not auto-create from request paths.
     */
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },
    /** accounts/{accountId} */
    googleAccountName: { type: String, required: true },
    /** accounts/{accountId}/locations/{locationId} — reviews API parent */
    googleLocationName: { type: String, required: true },
    /** locations/{locationId} from Business Information API */
    businessInfoName: { type: String, required: true },
    title: { type: String, default: "" },
    storeCode: { type: String, default: "" },
    address: { type: String, default: "" },
    /** Optional WGS84 coordinates (discovery cache / TRONX draft edits). */
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    placeId: { type: String, default: "" },
    lastDiscoveryAt: { type: Date, default: null },
    lastReviewsSyncAt: { type: Date, default: null },
    lastReviewsSyncError: { type: String, default: "" },
    /**
     * Verifications API–backed status. Defaults to unknown until a Super Admin
     * refresh; creation/discovery never invents verified.
     */
    verificationStatus: {
      type: String,
      enum: LOCATION_VERIFICATION_STATUSES,
      default: "unknown",
      index: true,
    },
    verificationLastCheckedAt: { type: Date, default: null },
    /** Raw VoiceOfMerchant booleans from last successful refresh (nullable). */
    verificationHasVoiceOfMerchant: { type: Boolean, default: null },
    verificationHasBusinessAuthority: { type: Boolean, default: null },
    /**
     * Recommended gain_voice_of_merchant action key from Google, when present:
     * verify | waitForVoiceOfMerchant | resolveOwnershipConflict | complyWithGuidelines
     */
    verificationRecommendedAction: { type: String, default: "" },
    /** locations/{locationId}/verifications/{verificationId} */
    latestVerificationName: { type: String, default: "" },
    latestVerificationMethod: { type: String, default: "" },
    /** PENDING | COMPLETED | FAILED | STATE_UNSPECIFIED | "" */
    latestVerificationState: { type: String, default: "" },
    verificationLastError: { type: String, default: "" },
  },
  { timestamps: true }
);

locationSchema.index(
  { orgId: 1, googleLocationName: 1 },
  { unique: true }
);

/**
 * Schema declaration for ops/docs. Create this index via
 * scripts/ensureLocationBusinessIdUniqueIndex.mjs after duplicate diagnostics.
 * Do not call syncIndexes blindly in production if duplicates may exist.
 * partialFilterExpression: only assigned rows (ObjectId businessId).
 */
locationSchema.index(
  { businessId: 1 },
  {
    unique: true,
    name: "location_businessId_unique_partial",
    partialFilterExpression: {
      businessId: { $exists: true, $type: "objectId" },
    },
  }
);

export type LocationDocument = InferSchemaType<typeof locationSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Location: Model<LocationDocument> =
  mongoose.models.Location ||
  mongoose.model<LocationDocument>("Location", locationSchema);
