import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import {
  PLAN_CODES,
  PLAN_STATUSES,
  defaultPlanFields,
} from "@/lib/entitlements/plans";

import {
  BUSINESS_LIFECYCLE_STATUSES,
  type BusinessLifecycleStatus,
} from "@/lib/business/lifecycle";

export const REPLY_MODES = ["manual", "auto"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];
export { BUSINESS_LIFECYCLE_STATUSES };
export type { BusinessLifecycleStatus };

export const BRAND_VOICES = [
  "friendly",
  "professional",
  "casual",
  "premium",
  "empathetic",
  "concise",
] as const;

const businessSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    profile: {
      description: { type: String, default: "" },
      website: { type: String, default: "" },
      phone: { type: String, default: "" },
    },
    /**
     * Google location resource names assigned to this business
     * (accounts/{a}/locations/{l}). Assignment is explicit — never auto-bulk.
     * Product rule: at most one location per business (enforced in
     * assignLocations + array validate below; no migration/index run here).
     */
    googleLocationNames: {
      type: [String],
      default: [],
      validate: {
        validator(v: string[]) {
          return !Array.isArray(v) || v.length <= 1;
        },
        message: "A business may have at most one Google location name.",
      },
    },
    /** Local Location document refs (org-scoped). Max one id. */
    locationIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "Location",
        },
      ],
      default: [],
      validate: {
        validator(v: mongoose.Types.ObjectId[]) {
          return !Array.isArray(v) || v.length <= 1;
        },
        message: "A business may have at most one assigned location.",
      },
    },
    /**
     * Provisional Google OAuth organization that holds the GBP connection.
     * Required so publishing can resolve tokens without trusting the client.
     */
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    /**
     * Internal TRONX BusinessGroup (not Organization / not Google).
     * A business belongs to at most one group. Null = ungrouped.
     */
    groupId: {
      type: Schema.Types.ObjectId,
      ref: "BusinessGroup",
      default: null,
      index: true,
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    replyMode: {
      type: String,
      enum: REPLY_MODES,
      default: "manual",
    },
    /**
     * When true, Business Admins may PATCH replyMode for this business.
     * Default false — Super Admin only. Never authorizes auto-publish.
     */
    ownersMayChangeReplyMode: {
      type: Boolean,
      default: false,
    },
    /**
     * When replyMode=auto, newly synced unreplied reviews may get AI drafts.
     * Never publishes. Independent of autoPublish.enabled (default OFF).
     */
    autoDraftOnSync: {
      type: Boolean,
      default: false,
    },
    brandVoice: {
      type: String,
      enum: BRAND_VOICES,
      default: "friendly",
    },
    /**
     * Optional outlet-level AI tone notes (sanitized, length-capped).
     * Never overrides risk checks, sanitization, or publishing safeguards.
     */
    replyToneNotes: { type: String, default: "", maxlength: 500 },
    preferredLanguage: { type: String, default: "English" },
    /**
     * Explicit lifecycle. When missing on legacy docs, resolve via
     * `resolveBusinessLifecycle` (active true→active, false→suspended).
     * Dual-written with `active` on lifecycle transitions.
     */
    status: {
      type: String,
      enum: BUSINESS_LIFECYCLE_STATUSES,
      default: "active",
      index: true,
    },
    /** Legacy operational flag — kept in sync with status for compatibility. */
    active: { type: Boolean, default: true, index: true },
    archivedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    /**
     * Manually assigned subscription (no payments). Enforced server-side via
     * lib/entitlements. Owners cannot modify their own entitlements.
     */
    plan: {
      code: {
        type: String,
        enum: PLAN_CODES,
        default: "starter",
      },
      displayName: { type: String, default: "Starter" },
      status: {
        type: String,
        enum: PLAN_STATUSES,
        default: "active",
      },
      features: {
        reviewSync: { type: Boolean, default: true },
        aiDrafts: { type: Boolean, default: true },
        advancedAnalytics: { type: Boolean, default: false },
        automation: { type: Boolean, default: false },
      },
      limits: {
        maxLocations: { type: Number, default: 1 },
        maxOwnerAccounts: { type: Number, default: 1 },
        monthlyAiDraftQuota: { type: Number, default: 50 },
      },
      usage: {
        aiDraftsThisPeriod: { type: Number, default: 0 },
        periodStart: { type: Date, default: Date.now },
      },
      assignedAt: { type: Date, default: Date.now },
      notes: { type: String, default: "" },
    },
    /**
     * replyMode is preference storage only. It does NOT enable automatic
     * Google publishing. Use autoPublish + plan.features.automation +
     * AUTO_PUBLISH_GLOBALLY_ENABLED instead.
     */
    /**
     * Explicit automatic publishing controls (disabled by default).
     * Independent of replyMode.
     */
    autoPublish: {
      enabled: { type: Boolean, default: false },
      syncIntervalMinutes: { type: Number, default: 60 },
      publishDelayMinutes: { type: Number, default: 15 },
      maxAutoStarRatingExclusive: { type: Number, default: 3 },
      disabledByAdmin: { type: Boolean, default: false },
    },
    lastSyncError: { type: String, default: "" },
    lastPublishError: { type: String, default: "" },
    /**
     * Exclusive lock while Super Admin permanent deletion runs.
     * Cleared only by successful Business.deleteOne; retries resume when set.
     */
    permanentDelete: {
      inProgress: { type: Boolean, default: false },
      startedAt: { type: Date, default: null },
      startedByUserId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
    },
  },
  { timestamps: true }
);

businessSchema.pre("validate", function setDefaultPlan() {
  if (!this.plan || !this.plan.code) {
    const defaults = defaultPlanFields("starter");
    this.set("plan", defaults);
  }
});

businessSchema.index({ name: 1, orgId: 1 });

export type BusinessDocument = InferSchemaType<typeof businessSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Business: Model<BusinessDocument> =
  mongoose.models.Business ||
  mongoose.model<BusinessDocument>("Business", businessSchema);
