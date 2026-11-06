/**
 * Super Admin permanent business deletion.
 *
 * Exact delete / retain / unlink behavior (do not invent cascades):
 *
 * DELETE (business-scoped TRONX records only):
 * - Business document
 * - AutoPublishJob rows for this businessId
 * - SeoKeyword + SeoRanking for this businessId
 * - GmbServiceJob for this businessId
 * - FakeReviewFlag for this businessId
 * - BusinessMedia for this businessId (Cloudinary destroy best-effort not required here)
 * - GoogleConnection where connectionSource=business_owner AND businessId matches
 * - OAuthState rows bound to this businessId
 * - Owner User account only when role=business_owner and businessIds becomes empty
 *
 * UNLINK / CLEAR (preserve org Google sync identity):
 * - Location.businessId → null (Location docs retained; never deleted)
 * - Review.businessId → null; clear TRONX draft fields only (Review docs retained)
 * - User.businessIds pull this businessId when owner keeps other businesses
 *
 * RETAIN always:
 * - AuditEvent (permanent historical evidence; businessId may dangle)
 * - ManualPayment (financial history)
 * - Organization
 * - platform GoogleConnection (org-scoped; businessId null)
 * - Location / Review documents (GBP sync cache — never delete Google resources)
 * - Other businesses in the same organization
 *
 * Preconditions: business must be archived; no unsafe in-flight publish claims.
 */

import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { resolveBusinessLifecycle } from "@/lib/business/lifecycle";
import { cancelOpenAutoPublishJobsForBusiness } from "@/lib/autoPublish/cancelJobs";
import { auditLog } from "@/lib/audit/log";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";
import { AutoPublishJob } from "@/models/AutoPublishJob";
import { SeoKeyword } from "@/models/SeoKeyword";
import { SeoRanking } from "@/models/SeoRanking";
import { GmbServiceJob } from "@/models/GmbServiceJob";
import { FakeReviewFlag } from "@/models/FakeReviewFlag";
import { ManualPayment } from "@/models/ManualPayment";
import { AuditEvent } from "@/models/AuditEvent";
import { GoogleConnection } from "@/models/GoogleConnection";
import { OAuthState } from "@/models/OAuthState";
import { User } from "@/models/User";
import { Organization } from "@/models/Organization";
import { BusinessMedia } from "@/models/BusinessMedia";
import {
  PERMANENT_DELETE_CONFIRM_PHRASE,
  type PermanentDeleteCounts,
  type PermanentDeleteOwnerSummary,
  type PermanentDeletePreview,
} from "@/lib/business/permanentDeleteTypes";

export {
  PERMANENT_DELETE_CONFIRM_PHRASE,
  type PermanentDeleteCounts,
  type PermanentDeleteOwnerSummary,
  type PermanentDeletePreview,
} from "@/lib/business/permanentDeleteTypes";

const OPEN_AUTO_PUBLISH = [
  "queued_auto_publish",
  "awaiting_approval",
  "draft_generated",
  "processing",
] as const;

export class PermanentDeleteError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "PermanentDeleteError";
    this.code = code;
    this.status = status;
  }
}

export type PermanentDeleteActor = {
  actorId: string;
  actorRole: string;
};

export type PermanentDeleteResult = {
  alreadyDeleted: boolean;
  businessId: string;
  name: string;
  orgId: string | null;
  deleted: Record<string, number>;
  unlinked: Record<string, number>;
  retained: Record<string, number>;
  ownersDeleted: number;
  ownersUnlinked: number;
};

function assertValidBusinessId(businessId: string): void {
  if (!mongoose.isValidObjectId(businessId)) {
    throw new PermanentDeleteError("Invalid business id.", {
      code: "invalid_business_id",
      status: 400,
    });
  }
}

async function countUnsafeInFlight(businessId: string): Promise<{
  processingAutoPublish: number;
  publishClaims: number;
}> {
  const now = new Date();
  const [processingAutoPublish, publishClaims] = await Promise.all([
    AutoPublishJob.countDocuments({
      businessId,
      status: "processing",
      claimExpiresAt: { $gt: now },
    }),
    Review.countDocuments({
      businessId,
      publishClaimExpiresAt: { $gt: now },
    }),
  ]);
  return { processingAutoPublish, publishClaims };
}

async function loadOwnerSummaries(
  ownerUserId: mongoose.Types.ObjectId | null | undefined,
  businessId: string
): Promise<PermanentDeleteOwnerSummary[]> {
  if (!ownerUserId) return [];
  const owner = await User.findById(ownerUserId)
    .select("email active role businessIds")
    .lean();
  if (!owner) return [];
  const otherBusinessCount = (owner.businessIds || []).filter(
    (id) => String(id) !== businessId
  ).length;
  const willDeleteAccount =
    owner.role === "business_owner" && otherBusinessCount === 0;
  return [
    {
      id: String(owner._id),
      email: String(owner.email || ""),
      active: Boolean(owner.active),
      otherBusinessCount,
      willDeleteAccount,
    },
  ];
}

export async function previewPermanentDelete(
  businessId: string
): Promise<PermanentDeletePreview> {
  assertValidBusinessId(businessId);
  await connectToDatabase();

  const business = await Business.findById(businessId).lean();
  if (!business) {
    throw new PermanentDeleteError("Business not found.", {
      code: "business_not_found",
      status: 404,
    });
  }

  const status = resolveBusinessLifecycle(business);
  const blockers: string[] = [];
  if (status !== "archived") {
    blockers.push(
      "Business must be archived before permanent deletion. Archive first, then delete."
    );
  }

  const inFlight = await countUnsafeInFlight(businessId);
  if (inFlight.processingAutoPublish > 0 || inFlight.publishClaims > 0) {
    blockers.push(
      "Unsafe in-flight publish operation detected. Wait for claims to expire or cancel jobs, then retry."
    );
  }

  const [
    locationsAssigned,
    reviewsLinked,
    draftsPresent,
    autoPublishJobs,
    autoPublishOpen,
    seoKeywords,
    seoRankings,
    gmbServiceJobs,
    fakeReviewFlags,
    manualPaymentsRetained,
    auditEventsRetained,
    businessOwnerConnections,
    oauthStates,
  ] = await Promise.all([
    Location.countDocuments({ businessId }),
    Review.countDocuments({ businessId }),
    Review.countDocuments({
      businessId,
      $or: [
        { draftText: { $nin: ["", null] } },
        { draftStatus: { $nin: ["none", "", null] } },
        { draftApproved: true },
      ],
    }),
    AutoPublishJob.countDocuments({ businessId }),
    AutoPublishJob.countDocuments({
      businessId,
      status: { $in: [...OPEN_AUTO_PUBLISH] },
    }),
    SeoKeyword.countDocuments({ businessId }),
    SeoRanking.countDocuments({ businessId }),
    GmbServiceJob.countDocuments({ businessId }),
    FakeReviewFlag.countDocuments({ businessId }),
    ManualPayment.countDocuments({ businessId }),
    AuditEvent.countDocuments({ businessId }),
    GoogleConnection.countDocuments({
      businessId,
      connectionSource: "business_owner",
    }),
    OAuthState.countDocuments({ businessId }),
  ]);

  const owners = await loadOwnerSummaries(business.ownerUserId, businessId);
  const deletionInProgress = Boolean(business.permanentDelete?.inProgress);

  return {
    businessId: String(business._id),
    name: String(business.name || ""),
    orgId: String(business.orgId),
    status,
    canDelete: blockers.length === 0,
    blockers,
    owners,
    counts: {
      locationsAssigned,
      reviewsLinked,
      draftsPresent,
      autoPublishJobs,
      autoPublishOpen,
      seoKeywords,
      seoRankings,
      gmbServiceJobs,
      fakeReviewFlags,
      manualPaymentsRetained,
      auditEventsRetained,
      businessOwnerConnections,
      oauthStates,
      ownersLinked: owners.length,
    },
    willDelete: [
      "Business document",
      "AutoPublishJob rows for this business",
      "SEO keywords and rankings for this business",
      "GMB service jobs for this business",
      "Fake-review flags for this business",
      "business_owner GoogleConnection rows for this business only",
      "OAuthState rows bound to this business",
      "Owner account only if it has no other business associations",
    ],
    willUnlink: [
      "Location assignment (Location docs retained; businessId cleared)",
      "Review business association + TRONX draft fields (Review docs retained)",
      "Owner businessIds membership when the owner keeps other businesses",
    ],
    willRetain: [
      "AuditEvent rows (permanent evidence)",
      "ManualPayment / financial history",
      "Organization",
      "platform GoogleConnection (shared org connection)",
      "Location documents (GBP discovery cache)",
      "Review documents (GBP sync cache; Google replies untouched)",
      "Other businesses in the same organization",
    ],
    deletionInProgress,
  };
}

export type ExecutePermanentDeleteInput = {
  businessId: string;
  confirmName: unknown;
  confirmPermanentDelete: unknown;
  confirmPhrase: unknown;
  actor: PermanentDeleteActor;
  /** When true, resume a locked in-progress deletion (same confirmations required). */
  resume?: boolean;
};

function validateConfirmations(
  businessName: string,
  input: ExecutePermanentDeleteInput
): void {
  const confirmName = String(input.confirmName ?? "");
  if (confirmName !== businessName) {
    throw new PermanentDeleteError(
      "Confirmation name does not match the business name exactly.",
      { code: "confirm_name_mismatch", status: 400 }
    );
  }
  if (input.confirmPermanentDelete !== true) {
    throw new PermanentDeleteError(
      "Explicit second confirmation (confirmPermanentDelete: true) is required.",
      { code: "confirm_second_required", status: 400 }
    );
  }
  const phrase = String(input.confirmPhrase ?? "").trim();
  if (phrase !== PERMANENT_DELETE_CONFIRM_PHRASE) {
    throw new PermanentDeleteError(
      `Type ${PERMANENT_DELETE_CONFIRM_PHRASE} exactly to confirm permanent deletion.`,
      { code: "confirm_phrase_mismatch", status: 400 }
    );
  }
}

/**
 * Permanently delete one archived business. Idempotent when the business is
 * already gone. Never trusts client-supplied related ids — all scopes use the
 * authorized businessId from the route after Super Admin auth.
 */
export async function executePermanentDelete(
  input: ExecutePermanentDeleteInput
): Promise<PermanentDeleteResult> {
  assertValidBusinessId(input.businessId);
  if (input.actor.actorRole !== "superadmin") {
    throw new PermanentDeleteError("Super Admin access required.", {
      code: "forbidden",
      status: 403,
    });
  }

  await connectToDatabase();
  const businessId = input.businessId;

  let business = await Business.findById(businessId).exec();
  if (!business) {
    // Idempotent success — prior deletion completed.
    auditLog({
      actorId: input.actor.actorId,
      actorRole: input.actor.actorRole,
      action: "business.permanent_delete",
      success: true,
      code: "already_deleted",
      target: { businessId, alreadyDeleted: true },
    });
    return {
      alreadyDeleted: true,
      businessId,
      name: "",
      orgId: null,
      deleted: {},
      unlinked: {},
      retained: {},
      ownersDeleted: 0,
      ownersUnlinked: 0,
    };
  }

  const name = String(business.name || "");
  const orgId = String(business.orgId);
  validateConfirmations(name, input);

  const status = resolveBusinessLifecycle(business);
  if (status !== "archived") {
    throw new PermanentDeleteError(
      "Business must be archived before permanent deletion.",
      { code: "require_archived", status: 409 }
    );
  }

  const inFlight = await countUnsafeInFlight(businessId);
  if (inFlight.processingAutoPublish > 0 || inFlight.publishClaims > 0) {
    throw new PermanentDeleteError(
      "Cannot delete while an unsafe in-flight publish operation exists.",
      { code: "unsafe_in_flight", status: 409 }
    );
  }

  const alreadyLocked = Boolean(business.permanentDelete?.inProgress);
  if (alreadyLocked && !input.resume) {
    throw new PermanentDeleteError(
      "Permanent deletion is already in progress. Retry with resume=true after confirming identity again.",
      { code: "deletion_in_progress", status: 409 }
    );
  }

  // Acquire / refresh exclusive lock before mutating related collections.
  // Atomic: concurrent non-resume requests cannot both win.
  const lockFilter = input.resume
    ? {
        _id: businessId,
        status: "archived" as const,
        $or: [
          { "permanentDelete.inProgress": true },
          { "permanentDelete.inProgress": { $ne: true } },
        ],
      }
    : {
        _id: businessId,
        status: "archived" as const,
        "permanentDelete.inProgress": { $ne: true },
      };

  const locked = await Business.findOneAndUpdate(
    lockFilter,
    {
      $set: {
        permanentDelete: {
          inProgress: true,
          startedAt: new Date(),
          startedByUserId: mongoose.isValidObjectId(input.actor.actorId)
            ? input.actor.actorId
            : null,
        },
        "autoPublish.enabled": false,
        "autoPublish.disabledByAdmin": true,
      },
    },
    { returnDocument: "after" }
  ).exec();

  if (!locked) {
    const stillThere = await Business.findById(businessId).select("_id").lean();
    if (!stillThere) {
      return {
        alreadyDeleted: true,
        businessId,
        name,
        orgId,
        deleted: {},
        unlinked: {},
        retained: {},
        ownersDeleted: 0,
        ownersUnlinked: 0,
      };
    }
    throw new PermanentDeleteError(
      "Could not acquire deletion lock (concurrent request).",
      { code: "deletion_lock_failed", status: 409 }
    );
  }

  business = locked;

  const deleted: Record<string, number> = {};
  const unlinked: Record<string, number> = {};
  const retained: Record<string, number> = {};

  try {
    // 1) Disarm workers: cancel open jobs, then remove all job rows for this biz.
    deleted.autoPublishCancelled = await cancelOpenAutoPublishJobsForBusiness(
      businessId,
      "business_permanent_delete"
    );
    const apDel = await AutoPublishJob.deleteMany({ businessId });
    deleted.autoPublishJobs = apDel.deletedCount || 0;

    // 2) Business-scoped staff data
    const seoRankDel = await SeoRanking.deleteMany({ businessId });
    deleted.seoRankings = seoRankDel.deletedCount || 0;
    const seoKwDel = await SeoKeyword.deleteMany({ businessId });
    deleted.seoKeywords = seoKwDel.deletedCount || 0;
    const gmbDel = await GmbServiceJob.deleteMany({ businessId });
    deleted.gmbServiceJobs = gmbDel.deletedCount || 0;
    const flagDel = await FakeReviewFlag.deleteMany({ businessId });
    deleted.fakeReviewFlags = flagDel.deletedCount || 0;
    const mediaDel = await BusinessMedia.deleteMany({ businessId });
    deleted.businessMedia = mediaDel.deletedCount || 0;

    // 3) Owner-scoped Google tokens for THIS business only (never platform)
    const connDel = await GoogleConnection.deleteMany({
      businessId,
      connectionSource: "business_owner",
    });
    deleted.businessOwnerConnections = connDel.deletedCount || 0;

    const oauthDel = await OAuthState.deleteMany({ businessId });
    deleted.oauthStates = oauthDel.deletedCount || 0;

    // 4) Unassign locations — retain Location documents
    const locRes = await Location.updateMany(
      { businessId },
      { $set: { businessId: null } }
    );
    unlinked.locations = locRes.modifiedCount || 0;

    // 5) Unlink reviews + clear TRONX drafts — retain Review documents
    const reviewRes = await Review.updateMany(
      { businessId },
      {
        $set: {
          businessId: null,
          draftText: "",
          draftStatus: "none",
          draftApproved: false,
          draftUpdatedAt: null,
          draftGeneratedAt: null,
          publishClaimOwner: null,
          publishClaimExpiresAt: null,
        },
      }
    );
    unlinked.reviews = reviewRes.modifiedCount || 0;

    // 6) Retention counts (never delete these)
    retained.manualPayments = await ManualPayment.countDocuments({
      businessId,
    });
    retained.auditEvents = await AuditEvent.countDocuments({ businessId });
    retained.organizations = await Organization.countDocuments({
      _id: business.orgId,
    });
    retained.platformGoogleConnections = await GoogleConnection.countDocuments({
      orgId: business.orgId,
      connectionSource: "platform",
    });
    retained.siblingBusinesses = await Business.countDocuments({
      orgId: business.orgId,
      _id: { $ne: business._id },
    });

    // 7) Owner unlink / conditional account delete
    let ownersDeleted = 0;
    let ownersUnlinked = 0;
    const ownerId = business.ownerUserId;
    if (ownerId) {
      const owner = await User.findById(ownerId).exec();
      if (owner) {
        const before = (owner.businessIds || []).map((id) => String(id));
        owner.businessIds = (owner.businessIds || []).filter(
          (id) => String(id) !== businessId
        );
        if (owner.businessIds.length === 0 && owner.role === "business_owner") {
          await User.deleteOne({ _id: owner._id, role: "business_owner" });
          ownersDeleted = 1;
          deleted.ownerAccounts = 1;
        } else {
          await owner.save();
          ownersUnlinked = before.includes(businessId) ? 1 : 0;
          unlinked.ownerMemberships = ownersUnlinked;
        }
      }
    }

    // 8) Delete business last — lock goes with the document
    const bizDel = await Business.deleteOne({ _id: businessId });
    deleted.business = bizDel.deletedCount || 0;
    if ((bizDel.deletedCount || 0) < 1) {
      throw new PermanentDeleteError(
        "Business document could not be removed after related cleanup.",
        { code: "business_delete_failed", status: 500 }
      );
    }

    auditLog({
      actorId: input.actor.actorId,
      actorRole: input.actor.actorRole,
      action: "business.permanent_delete",
      success: true,
      target: {
        businessId,
        businessName: name,
        orgId,
        deletedAutoPublishJobs: deleted.autoPublishJobs,
        deletedSeoKeywords: deleted.seoKeywords,
        deletedSeoRankings: deleted.seoRankings,
        deletedGmbJobs: deleted.gmbServiceJobs,
        deletedFlags: deleted.fakeReviewFlags,
        deletedOwnerConnections: deleted.businessOwnerConnections,
        unlinkedLocations: unlinked.locations,
        unlinkedReviews: unlinked.reviews,
        retainedManualPayments: retained.manualPayments,
        retainedAuditEvents: retained.auditEvents,
        ownersDeleted,
        ownersUnlinked,
      },
    });

    return {
      alreadyDeleted: false,
      businessId,
      name,
      orgId,
      deleted,
      unlinked,
      retained,
      ownersDeleted,
      ownersUnlinked,
    };
  } catch (err) {
    auditLog({
      actorId: input.actor.actorId,
      actorRole: input.actor.actorRole,
      action: "business.permanent_delete",
      success: false,
      code:
        err instanceof PermanentDeleteError ? err.code : "delete_partial_failure",
      target: {
        businessId,
        businessName: name,
        orgId,
        deletionInProgress: true,
      },
    });
    // Leave permanentDelete.inProgress=true so concurrent workers stay blocked;
    // Super Admin may retry with resume=true (steps are idempotent).
    if (err instanceof PermanentDeleteError) throw err;
    throw new PermanentDeleteError(
      "Permanent deletion failed partway. Business remains locked; retry with resume=true.",
      { code: "delete_partial_failure", status: 500 }
    );
  }
}
