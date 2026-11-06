import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { assertLifecycleAllowsAction } from "@/lib/auth/operationalGuard";
import { sanitizeReplyDraft } from "@/lib/ai/sanitizeDraft";
import { getValidAccessTokenForContext } from "@/lib/google/accessToken";
import {
  googleApiPutJson,
  MYBUSINESS_V4_BASE,
  buildUrl,
} from "@/lib/google/gbpClient";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import {
  loadBusinessPlan,
  EntitlementError,
} from "@/lib/entitlements/enforce";
import { planAllowsOperations } from "@/lib/entitlements/plans";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";
import {
  LOCATION_UNASSIGNED_MESSAGE,
  pickBusinessIdFromAssignment,
} from "@/lib/reviews/resolveReviewBusiness";

type FetchLike = typeof fetch;

/** Google ReviewReply.comment max length is 4096 bytes. */
export const GOOGLE_REPLY_MAX_BYTES = 4096;

/** Publish claim lease across instances (ms). */
export const PUBLISH_CLAIM_LEASE_MS = 2 * 60 * 1000;

const GOOGLE_REVIEW_NAME_RE =
  /^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/;

/** In-process guard (defense in depth; DB claim is authoritative). */
const inFlightPublishes = new Map<string, Promise<PublishReplyResult>>();

export type PublishReplyResult = {
  replyComment: string;
  replyUpdateTime: string | null;
  replyState: string;
  replacedExisting: boolean;
};

export class PublishReplyError extends Error {
  code: string;
  status: number;
  existingReply?: string;

  constructor(
    message: string,
    {
      code = "publish_error",
      status = 400,
      existingReply,
    }: { code?: string; status?: number; existingReply?: string } = {}
  ) {
    super(message);
    this.name = "PublishReplyError";
    this.code = code;
    this.status = status;
    this.existingReply = existingReply;
  }
}

export function validateReplyComment(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new PublishReplyError("Reply text must be a string.", {
      code: "invalid_reply",
      status: 400,
    });
  }
  const comment = raw.trim();
  if (!comment) {
    throw new PublishReplyError("Reply text cannot be empty.", {
      code: "invalid_reply",
      status: 400,
    });
  }
  const byteLength = Buffer.byteLength(comment, "utf8");
  if (byteLength > GOOGLE_REPLY_MAX_BYTES) {
    throw new PublishReplyError(
      `Reply text exceeds Google's ${GOOGLE_REPLY_MAX_BYTES}-byte limit (${byteLength} bytes).`,
      { code: "invalid_reply", status: 400 }
    );
  }
  return comment;
}

/**
 * Sanitize then validate the final reply text before any Google write.
 * Publication status is updated only after Google confirms success.
 */
export function prepareReplyForPublish(raw: unknown): string {
  const sanitized = sanitizeReplyDraft(String(raw ?? ""));
  return validateReplyComment(sanitized);
}

export function isPlausibleGoogleReviewName(name: string): boolean {
  return GOOGLE_REVIEW_NAME_RE.test(name.trim());
}

interface GoogleReviewReply {
  comment?: string;
  updateTime?: string;
  reviewReplyState?: string;
}

function flightKey(orgId: string, reviewId: string): string {
  return `${orgId}:${reviewId}`;
}

/** Test helper. */
export function resetPublishInFlightForTests(): void {
  inFlightPublishes.clear();
}

async function releasePublishClaim(
  reviewId: mongoose.Types.ObjectId,
  orgId: string,
  claimOwner: string
): Promise<void> {
  await Review.updateOne(
    { _id: reviewId, orgId, publishClaimOwner: claimOwner },
    {
      $set: {
        publishClaimOwner: null,
        publishClaimExpiresAt: null,
      },
    }
  );
}

/**
 * Publish or update a Google Business Profile review reply via the official
 * accounts.locations.reviews.updateReply endpoint.
 *
 * Resource names come only from org-owned Mongo documents — never from the client.
 * Enforces lifecycle + active plan before Google write. DB claim prevents
 * multi-instance duplicate publishes.
 */
/**
 * Atomically acquire the publish lease for a review.
 * Expired leases are reclaimable in the same update (no separate clear race).
 */
export async function acquirePublishClaim(input: {
  orgId: string;
  reviewId: string;
  claimOwner: string;
  now?: Date;
  leaseMs?: number;
}): Promise<{
  claimed: mongoose.Document & {
    _id: mongoose.Types.ObjectId;
    googleReviewName: string;
    locationId: mongoose.Types.ObjectId;
    businessId?: mongoose.Types.ObjectId | null;
    replyComment?: string | null;
    publishClaimOwner?: string | null;
    publishClaimExpiresAt?: Date | null;
  };
}> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? PUBLISH_CLAIM_LEASE_MS;
  const claimed = await Review.findOneAndUpdate(
    {
      _id: input.reviewId,
      orgId: input.orgId,
      $or: [
        { publishClaimOwner: null },
        { publishClaimOwner: { $exists: false } },
        { publishClaimExpiresAt: null },
        { publishClaimExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        publishClaimOwner: input.claimOwner,
        publishClaimExpiresAt: new Date(now.getTime() + leaseMs),
      },
    },
    { returnDocument: "after" }
  ).exec();

  if (!claimed) {
    const existing = await Review.findOne({
      _id: input.reviewId,
      orgId: input.orgId,
    })
      .select("_id")
      .lean();
    if (!existing) {
      throw new PublishReplyError("Review not found for this organization.", {
        code: "not_found",
        status: 404,
      });
    }
    throw new PublishReplyError(
      "A publish request for this review is already in progress.",
      { code: "in_flight", status: 409 }
    );
  }

  return { claimed: claimed as never };
}

export async function publishReviewReply(input: {
  orgId: string;
  reviewId: string;
  comment: unknown;
  confirmReplace?: boolean;
  fetchImpl?: FetchLike;
  /** Optional claim owner id (defaults to random UUID). */
  claimOwner?: string;
  /**
   * When true, skip the same-process Map guard so concurrent callers in one
   * test process exercise the Mongo lease (multi-instance simulation).
   */
  bypassInProcessGuard?: boolean;
}): Promise<PublishReplyResult> {
  const {
    orgId,
    reviewId,
    confirmReplace = false,
    fetchImpl = fetch,
  } = input;

  if (!mongoose.isValidObjectId(orgId) || !mongoose.isValidObjectId(reviewId)) {
    throw new PublishReplyError("Invalid review or organization id.", {
      code: "invalid_id",
      status: 400,
    });
  }

  const comment = prepareReplyForPublish(input.comment);
  const key = flightKey(orgId, reviewId);
  if (!input.bypassInProcessGuard) {
    const existingFlight = inFlightPublishes.get(key);
    if (existingFlight) {
      throw new PublishReplyError(
        "A publish request for this review is already in progress.",
        { code: "in_flight", status: 409 }
      );
    }
  }

  const claimOwner = input.claimOwner || `pub:${randomUUID()}`;
  const now = new Date();

  const work = (async (): Promise<PublishReplyResult> => {
    await connectToDatabase();

    const { claimed } = await acquirePublishClaim({
      orgId,
      reviewId,
      claimOwner,
      now,
    });

    try {
      if (!isPlausibleGoogleReviewName(claimed.googleReviewName)) {
        throw new PublishReplyError(
          "Stored Google review resource name is invalid. Re-fetch reviews and try again.",
          { code: "invalid_review_resource", status: 400 }
        );
      }

      const location = await Location.findOne({
        _id: claimed.locationId,
        orgId,
      }).exec();

      if (!location) {
        throw new PublishReplyError(
          "Location not found for this organization.",
          { code: "location_not_owned", status: 404 }
        );
      }

      const businessId = pickBusinessIdFromAssignment(
        claimed.businessId,
        location.businessId
      );

      if (!businessId) {
        throw new PublishReplyError(LOCATION_UNASSIGNED_MESSAGE, {
          code: "location_unassigned",
          status: 403,
        });
      }

      const business = await Business.findById(businessId)
        .select("active status plan")
        .lean();
      if (!business) {
        throw new PublishReplyError("Business not found.", {
          code: "not_found",
          status: 404,
        });
      }

      try {
        assertLifecycleAllowsAction(business, "publish");
      } catch (err) {
        throw new PublishReplyError(
          err instanceof Error
            ? err.message
            : "Business lifecycle blocks publishing.",
          { code: "business_lifecycle_blocked", status: 403 }
        );
      }

      // Plan eligibility — owners and Super Admin support both require active plan.
      // Client-supplied businessId is never trusted; we use the stored association.
      try {
        const { plan } = await loadBusinessPlan(businessId);
        if (!planAllowsOperations(plan.status)) {
          throw new PublishReplyError(
            `Subscription is ${plan.status}. Publishing is unavailable until a Super Admin reactivates the plan.`,
            { code: "plan_inactive", status: 403 }
          );
        }
      } catch (err) {
        if (err instanceof PublishReplyError) throw err;
        if (err instanceof EntitlementError) {
          throw new PublishReplyError(err.message, {
            code: err.code,
            status: err.status,
          });
        }
        throw err;
      }

      const expectedPrefix = `${location.googleLocationName}/reviews/`;
      if (!claimed.googleReviewName.startsWith(expectedPrefix)) {
        throw new PublishReplyError(
          "Review does not belong to the organization location on record.",
          { code: "location_mismatch", status: 400 }
        );
      }

      const existingReply = (claimed.replyComment || "").trim();
      const replacedExisting = Boolean(existingReply);
      if (replacedExisting && !confirmReplace) {
        throw new PublishReplyError(
          "This review already has a published reply. Confirm replacement to update it on Google.",
          {
            code: "needs_replace_confirmation",
            status: 409,
            existingReply,
          }
        );
      }

      // Re-validate lease before external side effect (stale holder after reclaim).
      const stillOwned = await Review.findOne({
        _id: claimed._id,
        orgId,
        publishClaimOwner: claimOwner,
        publishClaimExpiresAt: { $gt: new Date() },
      })
        .select("_id")
        .lean();
      if (!stillOwned) {
        throw new PublishReplyError(
          "Publish claim was lost or expired before calling Google. Another instance may hold the lease.",
          { code: "claim_lost", status: 409 }
        );
      }

      const accessToken = await getValidAccessTokenForContext(
        { orgId, businessId },
        fetchImpl
      );
      const url = buildUrl(
        MYBUSINESS_V4_BASE,
        `${claimed.googleReviewName}/reply`
      );

      let googleReply: GoogleReviewReply;
      try {
        // Do not auto-retry publish: claim lease + replace confirmation must
        // stay single-shot at this layer (transient retries would multiply PUTs).
        googleReply = await googleApiPutJson<GoogleReviewReply>(
          url,
          accessToken,
          { comment },
          fetchImpl,
          { retry: false }
        );
      } catch (err) {
        if (err instanceof GoogleBusinessApiError) {
          throw err;
        }
        throw new GoogleBusinessApiError(
          "Failed to publish reply to Google Business Profile.",
          { code: "publish_failed", status: 502 }
        );
      }

      const publishedComment =
        typeof googleReply.comment === "string" && googleReply.comment.trim()
          ? googleReply.comment.trim()
          : comment;
      const replyUpdateTime = googleReply.updateTime
        ? new Date(googleReply.updateTime)
        : new Date();
      const replyState =
        typeof googleReply.reviewReplyState === "string"
          ? googleReply.reviewReplyState
          : "APPROVED";

      const publishedAt = new Date();
      // Only the claim owner may mark published — prevents stolen claims.
      const marked = await Review.updateOne(
        {
          _id: claimed._id,
          orgId,
          publishClaimOwner: claimOwner,
        },
        {
          $set: {
            replyComment: publishedComment,
            replyUpdateTime: Number.isNaN(replyUpdateTime.getTime())
              ? publishedAt
              : replyUpdateTime,
            replyState,
            replySource: "tronx_published",
            tronxPublishedAt: publishedAt,
            lastPublishError: "",
            draftStatus: "none",
            draftApproved: false,
            publishClaimOwner: null,
            publishClaimExpiresAt: null,
          },
        }
      );
      if ((marked.modifiedCount || 0) === 0) {
        throw new PublishReplyError(
          "Publish claim was lost before local confirmation. Verify Google state before retrying.",
          { code: "claim_lost", status: 409 }
        );
      }

      return {
        replyComment: publishedComment,
        replyUpdateTime: Number.isNaN(replyUpdateTime.getTime())
          ? new Date().toISOString()
          : replyUpdateTime.toISOString(),
        replyState,
        replacedExisting,
      };
    } catch (err) {
      await releasePublishClaim(claimed._id, orgId, claimOwner);
      if (
        err instanceof PublishReplyError ||
        err instanceof GoogleBusinessApiError
      ) {
        try {
          await Review.updateOne(
            { _id: claimed._id, orgId },
            {
              $set: {
                lastPublishError:
                  err instanceof PublishReplyError ||
                  err instanceof GoogleBusinessApiError
                    ? err.code
                    : "publish_failed",
              },
            }
          );
        } catch {
          // ignore secondary write
        }
      }
      throw err;
    }
  })();

  inFlightPublishes.set(key, work);
  try {
    return await work;
  } finally {
    inFlightPublishes.delete(key);
  }
}
