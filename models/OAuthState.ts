import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import { CONNECTION_SOURCES } from "@/models/GoogleConnection";

const oauthStateSchema = new Schema(
  {
    state: { type: String, required: true, unique: true, index: true },
    codeVerifier: { type: String, required: true, select: false },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    /**
     * Bound at OAuth start from the authenticated server session — never from
     * a client-chosen business/org id without prior authorization checks.
     */
    connectionSource: {
      type: String,
      enum: CONNECTION_SOURCES,
      default: "platform",
    },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },
    initiatedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    returnPath: { type: String, default: "/settings/google" },
    // TTL index declared below — avoid a duplicate single-field index.
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// TTL index: MongoDB removes expired unused states (and used ones after expiry).
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type OAuthStateDocument = InferSchemaType<typeof oauthStateSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const OAuthState: Model<OAuthStateDocument> =
  mongoose.models.OAuthState ||
  mongoose.model<OAuthStateDocument>("OAuthState", oauthStateSchema);
