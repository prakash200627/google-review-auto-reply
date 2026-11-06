import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import {
  AutoPublishJob,
  AUTO_PUBLISH_CLAIM_LEASE_MS,
} from "@/models/AutoPublishJob";
import { Business } from "@/models/Business";
import { Review } from "@/models/Review";
import {
  assertAutoPublishAuthorized,
  classifyAutoPublishRisk,
  isAutoPublishGloballyEnabled,
  normalizeAutoPublishConfig,
  AutoPublishPolicyError,
} from "@/lib/autoPublish/policy";
import { lifecycleAllowsAutoPublish } from "@/lib/business/lifecycle";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import {
  prepareReplyForPublish,
  publishReviewReply,
  PublishReplyError,
} from "@/lib/google/publishReply";
import { auditLog } from "@/lib/audit/log";

export type PublishAdapter = typeof publishReviewReply;

async function reclaimExpiredClaims(now: Date): Promise<number> {
  const result = await AutoPublishJob.updateMany(
    {
      status: "processing",
      claimExpiresAt: { $lte: now },
    },
    {
      $set: {
        status: "queued_auto_publish",
        claimOwner: null,
        claimExpiresAt: null,
        lastError: "claim_expired",
      },
    }
  );
  return result.modifiedCount || 0;
}

/**
 * Atomically claim the next due job. Only one worker wins.
 * Returns null when nothing is available.
 */
export async function claimNextAutoPublishJob(input: {
  now?: Date;
  workerId: string;
  leaseMs?: number;
}): Promise<{
  _id: mongoose.Types.ObjectId;
  orgId: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  reviewId: mongoose.Types.ObjectId;
  draftText: string;
  attempts: number;
  maxAttempts: number;
  claimOwner: string;
} | null> {
  const now = input.now || new Date();
  const leaseMs = input.leaseMs ?? AUTO_PUBLISH_CLAIM_LEASE_MS;
  const claimExpiresAt = new Date(now.getTime() + leaseMs);

  await reclaimExpiredClaims(now);

  const claimed = await AutoPublishJob.findOneAndUpdate(
    {
      status: "queued_auto_publish",
      publishAfter: { $lte: now },
      $expr: { $lt: ["$attempts", "$maxAttempts"] },
    },
    {
      $set: {
        status: "processing",
        claimOwner: input.workerId,
        claimExpiresAt,
        lastError: "",
      },
    },
    { sort: { publishAfter: 1 }, returnDocument: "after" }
  ).lean();

  if (!claimed) return null;
  return {
    _id: claimed._id,
    orgId: claimed.orgId as mongoose.Types.ObjectId,
    businessId: claimed.businessId as mongoose.Types.ObjectId,
    reviewId: claimed.reviewId as mongoose.Types.ObjectId,
    draftText: String(claimed.draftText || ""),
    attempts: claimed.attempts || 0,
    maxAttempts: claimed.maxAttempts || 3,
    claimOwner: String(claimed.claimOwner || input.workerId),
  };
}

async function finalizeClaimedJob(input: {
  jobId: mongoose.Types.ObjectId;
  claimOwner: string;
  status: "published" | "failed" | "queued_auto_publish" | "cancelled" | "awaiting_approval";
  lastError?: string;
  riskReason?: string;
  publishedAt?: Date | null;
  incAttempts?: boolean;
}): Promise<boolean> {
  const $set: Record<string, unknown> = {
    status: input.status,
    claimOwner: null,
    claimExpiresAt: null,
    lastError: input.lastError || "",
  };
  if (input.riskReason !== undefined) $set.riskReason = input.riskReason;
  if (input.publishedAt !== undefined) $set.publishedAt = input.publishedAt;
  if (input.status === "awaiting_approval") {
    $set.publishAfter = null;
  }

  const update: Record<string, unknown> = { $set };
  if (input.incAttempts !== false) {
    update.$inc = { attempts: 1 };
  }

  const result = await AutoPublishJob.updateOne(
    {
      _id: input.jobId,
      status: "processing",
      claimOwner: input.claimOwner,
    },
    update
  );
  return (result.modifiedCount || 0) > 0;
}

/**
 * Process due auto-publish jobs with atomic claiming.
 * Re-checks kill switch, lifecycle, plan, entitlement, risk, and reply state
 * immediately before publishing. Inject publishAdapter in tests.
 */
export async function processDueAutoPublishJobs(input: {
  limit?: number;
  now?: Date;
  publishAdapter?: PublishAdapter;
  actorId?: string | null;
  workerId?: string;
}): Promise<{
  processed: number;
  published: number;
  failed: number;
  skipped: number;
  reclaimed: number;
}> {
  const limit = Math.min(50, Math.max(1, input.limit ?? 10));
  const now = input.now || new Date();
  const publishAdapter = input.publishAdapter || publishReviewReply;
  const workerId = input.workerId || `worker:${randomUUID()}`;

  await connectToDatabase();
  const reclaimed = await reclaimExpiredClaims(now);

  let processed = 0;
  let published = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < limit; i += 1) {
    const job = await claimNextAutoPublishJob({ now, workerId });
    if (!job) break;
    processed += 1;

    const businessId = String(job.businessId);
    const reviewId = String(job.reviewId);
    const orgId = String(job.orgId);
    const claimOwner = job.claimOwner;

    try {
      if (!isAutoPublishGloballyEnabled()) {
        await finalizeClaimedJob({
          jobId: job._id,
          claimOwner,
          status: "cancelled",
          lastError: "global_kill_switch",
        });
        skipped += 1;
        continue;
      }

      const business = await Business.findById(businessId)
        .select("replyMode plan autoPublish active status")
        .lean();
      if (!business || !lifecycleAllowsAutoPublish(business)) {
        await finalizeClaimedJob({
          jobId: job._id,
          claimOwner,
          status: "cancelled",
          lastError: "business_unavailable",
        });
        skipped += 1;
        continue;
      }

      const plan = toPlanSnapshot(business.plan as never);
      const autoPublish = normalizeAutoPublishConfig(
        business.autoPublish as never
      );
      assertAutoPublishAuthorized({
        replyMode: business.replyMode,
        autoPublish,
        planStatus: plan.status,
        planFeatures: plan.features,
      });

      const review = await Review.findOne({
        _id: reviewId,
        businessId,
        orgId,
      })
        .select("replyComment starRating comment")
        .lean();
      if (!review) {
        await finalizeClaimedJob({
          jobId: job._id,
          claimOwner,
          status: "failed",
          lastError: "review_missing",
        });
        failed += 1;
        continue;
      }
      if ((review.replyComment || "").trim()) {
        await finalizeClaimedJob({
          jobId: job._id,
          claimOwner,
          status: "cancelled",
          lastError: "already_replied",
        });
        skipped += 1;
        continue;
      }

      // Process-time risk reclassification — fail closed.
      const risk = classifyAutoPublishRisk({
        starRating:
          typeof review.starRating === "number" ? review.starRating : null,
        maxAutoStarRatingExclusive: autoPublish.maxAutoStarRatingExclusive,
        comment: review.comment,
      });
      if (!risk.ok) {
        await finalizeClaimedJob({
          jobId: job._id,
          claimOwner,
          status: "awaiting_approval",
          lastError: risk.reason,
          riskReason: risk.reason,
        });
        skipped += 1;
        continue;
      }

      const comment = prepareReplyForPublish(job.draftText);
      await publishAdapter({
        orgId,
        reviewId,
        comment,
        confirmReplace: false,
      });

      const ok = await finalizeClaimedJob({
        jobId: job._id,
        claimOwner,
        status: "published",
        publishedAt: new Date(),
        lastError: "",
      });
      if (!ok) {
        // Claim lost — do not treat as published in this worker's count.
        failed += 1;
        continue;
      }
      published += 1;
      auditLog({
        actorId: input.actorId || null,
        actorRole: "system",
        action: "review.auto_publish",
        success: true,
        target: { businessId, reviewId, jobId: String(job._id) },
      });
    } catch (err) {
      const code =
        err instanceof AutoPublishPolicyError
          ? err.code
          : err instanceof PublishReplyError
            ? err.code
            : "publish_failed";
      const attempts = (job.attempts || 0) + 1;
      const terminal = attempts >= (job.maxAttempts || 3);
      await finalizeClaimedJob({
        jobId: job._id,
        claimOwner,
        status: terminal ? "failed" : "queued_auto_publish",
        lastError: code,
      });
      failed += 1;
      auditLog({
        actorId: input.actorId || null,
        actorRole: "system",
        action: "review.auto_publish",
        success: false,
        code,
        target: { businessId, reviewId, jobId: String(job._id) },
      });
    }
  }

  return {
    processed,
    published,
    failed,
    skipped,
    reclaimed,
  };
}

/** Test helper — cancel open jobs for a review (no Google calls). */
export async function cancelOpenAutoPublishJobsForReview(
  reviewId: string
): Promise<number> {
  if (!mongoose.isValidObjectId(reviewId)) return 0;
  await connectToDatabase();
  const result = await AutoPublishJob.updateMany(
    {
      reviewId,
      status: {
        $in: [
          "queued_auto_publish",
          "awaiting_approval",
          "draft_generated",
          "processing",
        ],
      },
    },
    {
      $set: {
        status: "cancelled",
        lastError: "cancelled_by_operator",
        claimOwner: null,
        claimExpiresAt: null,
      },
    }
  );
  return result.modifiedCount || 0;
}
