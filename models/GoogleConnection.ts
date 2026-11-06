import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const CONNECTION_SOURCES = ["platform", "business_owner"] as const;
export type ConnectionSource = (typeof CONNECTION_SOURCES)[number];

const googleConnectionSchema = new Schema(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    /**
     * platform — Super Admin–managed org connection (businessId null).
     * business_owner — tokens owned by one business; never shared across tenants.
     */
    connectionSource: {
      type: String,
      enum: CONNECTION_SOURCES,
      default: "platform",
      index: true,
    },
    /**
     * Set for business_owner connections. Null for platform connections.
     * Application logic never reuses another business's connection for token lookup.
     */
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      default: null,
      index: true,
    },
    /** User who completed OAuth (audit/support). Never used as an auth bypass. */
    connectedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    googleAccountEmail: { type: String, default: "" },
    /**
     * OpenID subject. Legacy deployments may still have a unique index on this
     * field alone — do not auto-sync indexes from the app. Dual workflows need
     * distinct connection docs per (source, business/org), so googleUserSub is
     * not uniquely constrained in this schema definition.
     */
    googleUserSub: { type: String, default: "" },
    encryptedAccessToken: { type: String, required: true, select: false },
    encryptedRefreshToken: { type: String, required: true, select: false },
    accessTokenExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["active", "revoked", "error"],
      default: "active",
    },
    lastError: { type: String, default: "" },
    connectedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

googleConnectionSchema.index({ orgId: 1, status: 1 });
googleConnectionSchema.index({ orgId: 1, connectionSource: 1, status: 1 });
googleConnectionSchema.index({ businessId: 1, connectionSource: 1, status: 1 });

export type GoogleConnectionDocument = InferSchemaType<
  typeof googleConnectionSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const GoogleConnection: Model<GoogleConnectionDocument> =
  mongoose.models.GoogleConnection ||
  mongoose.model<GoogleConnectionDocument>(
    "GoogleConnection",
    googleConnectionSchema
  );
