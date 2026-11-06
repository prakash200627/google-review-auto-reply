/**
 * Shared-database multi-instance publish lease tests.
 * Uses mongodb-memory-server (not in-memory mocks) so two concurrent
 * publishReviewReply callers compete on the same Mongo collection.
 *
 * Requires: mongodb-memory-server (devDependency).
 * Env: ALLOW_REMOTE_MONGO is unused — memory server is localhost.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("@/lib/google/accessToken", () => ({
  getValidAccessTokenForContext: vi.fn().mockResolvedValue("access-token"),
}));

vi.mock("@/lib/entitlements/enforce", () => ({
  loadBusinessPlan: vi.fn().mockResolvedValue({
    plan: { status: "active", code: "starter" },
  }),
  EntitlementError: class EntitlementError extends Error {
    code = "plan_error";
    status = 403;
  },
}));

vi.mock("@/lib/google/gbpClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/gbpClient")>(
    "@/lib/google/gbpClient"
  );
  return {
    ...actual,
    googleApiPutJson: vi.fn().mockResolvedValue({
      comment: "Thanks!",
      updateTime: "2024-01-01T00:00:00.000Z",
      reviewReplyState: "APPROVED",
    }),
  };
});

import { Business } from "@/models/Business";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";
import {
  acquirePublishClaim,
  PUBLISH_CLAIM_LEASE_MS,
  publishReviewReply,
  PublishReplyError,
  resetPublishInFlightForTests,
} from "@/lib/google/publishReply";
import { googleApiPutJson } from "@/lib/google/gbpClient";

describe("multi-instance publish lease (shared Mongo)", () => {
  let mongod: MongoMemoryServer;
  let orgId: mongoose.Types.ObjectId;
  let businessId: mongoose.Types.ObjectId;
  let locationId: mongoose.Types.ObjectId;
  let reviewId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri();
    // connectToDatabase() reads MONGODB_URI per call and will attach models.
    const { connectToDatabase } = await import("@/lib/mongodb");
    await connectToDatabase();
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect().catch(() => undefined);
    await mongod.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetPublishInFlightForTests();
    await Promise.all([
      Review.deleteMany({}),
      Location.deleteMany({}),
      Business.deleteMany({}),
    ]);

    orgId = new mongoose.Types.ObjectId();
    businessId = new mongoose.Types.ObjectId();
    locationId = new mongoose.Types.ObjectId();
    reviewId = new mongoose.Types.ObjectId();

    await Business.create({
      _id: businessId,
      name: "Cafe",
      orgId,
      active: true,
      status: "active",
      replyMode: "manual",
      brandVoice: "friendly",
      preferredLanguage: "English",
      googleLocationNames: ["accounts/1/locations/1"],
      locationIds: [locationId],
      plan: {
        code: "starter",
        status: "active",
        displayName: "Starter",
        features: {
          reviewSync: true,
          aiDrafts: true,
          advancedAnalytics: false,
          automation: false,
        },
        limits: {
          maxLocations: 1,
          maxOwnerAccounts: 1,
          monthlyAiDraftQuota: 50,
        },
        usage: { aiDraftsThisPeriod: 0, periodStart: new Date() },
      },
    });

    await Location.create({
      _id: locationId,
      orgId,
      businessId,
      googleAccountName: "accounts/1",
      googleLocationName: "accounts/1/locations/1",
      businessInfoName: "locations/1",
      title: "Cafe",
      address: "1 Main",
      verificationStatus: "unknown",
    });

    await Review.create({
      _id: reviewId,
      orgId,
      businessId,
      locationId,
      googleReviewName: "accounts/1/locations/1/reviews/r1",
      googleReviewId: "r1",
      starRating: 5,
      comment: "Great",
      createTime: new Date(),
      replyComment: "",
      publishClaimOwner: null,
      publishClaimExpiresAt: null,
    });
  });

  it("allows only one of two concurrent instances to claim the same review", async () => {
    // Hold the Google PUT until both callers have raced the Mongo lease.
    // Without this gate the winner can finish and clear the claim before the
    // loser acquires — then the loser correctly gets needs_replace_confirmation
    // instead of in_flight (reply already exists). That is valid product
    // behavior, but this test specifically asserts mid-flight lease contention.
    let releaseGoogle!: () => void;
    const googleGate = new Promise<void>((resolve) => {
      releaseGoogle = resolve;
    });
    vi.mocked(googleApiPutJson).mockImplementation(async () => {
      await googleGate;
      return {
        comment: "Thanks!",
        updateTime: "2024-01-01T00:00:00.000Z",
        reviewReplyState: "APPROVED",
      };
    });

    const pA = publishReviewReply({
      orgId: String(orgId),
      reviewId: String(reviewId),
      comment: "Thanks A",
      claimOwner: "instance:a",
      bypassInProcessGuard: true,
    });
    const pB = publishReviewReply({
      orgId: String(orgId),
      reviewId: String(reviewId),
      comment: "Thanks B",
      claimOwner: "instance:b",
      bypassInProcessGuard: true,
    });
    // Attach handlers immediately so a fast in_flight rejection is not "unhandled".
    const resultsPromise = Promise.allSettled([pA, pB]);

    // Wait until exactly one Google call is blocked on the gate (winner holds lease).
    const deadline = Date.now() + 5_000;
    while (vi.mocked(googleApiPutJson).mock.calls.length < 1) {
      if (Date.now() > deadline) {
        releaseGoogle();
        throw new Error("Timed out waiting for publish winner to call Google");
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    // Give the loser a moment to hit the occupied lease.
    await new Promise((r) => setTimeout(r, 50));
    releaseGoogle();

    const results = await resultsPromise;
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "in_flight",
      status: 409,
    });
    expect(googleApiPutJson).toHaveBeenCalledTimes(1);

    const row = await Review.findById(reviewId).lean();
    expect(row?.replyComment).toBe("Thanks!");
  });

  it("loser after winner finishes gets replace confirmation (not a lease bug)", async () => {
    // Fast mock — no gate — so the winner can complete before the loser claims.
    vi.mocked(googleApiPutJson).mockResolvedValue({
      comment: "Thanks!",
      updateTime: "2024-01-01T00:00:00.000Z",
      reviewReplyState: "APPROVED",
    });

    await publishReviewReply({
      orgId: String(orgId),
      reviewId: String(reviewId),
      comment: "Thanks A",
      claimOwner: "instance:a",
      bypassInProcessGuard: true,
    });

    await expect(
      publishReviewReply({
        orgId: String(orgId),
        reviewId: String(reviewId),
        comment: "Thanks B",
        claimOwner: "instance:b",
        bypassInProcessGuard: true,
        confirmReplace: false,
      })
    ).rejects.toMatchObject({
      code: "needs_replace_confirmation",
      status: 409,
    });
    expect(googleApiPutJson).toHaveBeenCalledTimes(1);
  });

  it("reclaims an expired lease for another instance", async () => {
    const past = new Date(Date.now() - 60_000);
    await Review.updateOne(
      { _id: reviewId },
      {
        $set: {
          publishClaimOwner: "instance:stale",
          publishClaimExpiresAt: past,
        },
      }
    );

    const { claimed } = await acquirePublishClaim({
      orgId: String(orgId),
      reviewId: String(reviewId),
      claimOwner: "instance:fresh",
      now: new Date(),
      leaseMs: PUBLISH_CLAIM_LEASE_MS,
    });

    expect(claimed.publishClaimOwner).toBe("instance:fresh");
  });

  it("blocks a stale lease holder from publishing after reclaim", async () => {
    await Review.updateOne(
      { _id: reviewId },
      {
        $set: {
          publishClaimOwner: "instance:stale",
          publishClaimExpiresAt: new Date(Date.now() - 1000),
        },
      }
    );

    // Fresh instance reclaims.
    await acquirePublishClaim({
      orgId: String(orgId),
      reviewId: String(reviewId),
      claimOwner: "instance:fresh",
    });

    // Stale holder tries full publish with its old owner token.
    await expect(
      publishReviewReply({
        orgId: String(orgId),
        reviewId: String(reviewId),
        comment: "Stale attempt",
        claimOwner: "instance:stale",
        bypassInProcessGuard: true,
      })
    ).rejects.toBeInstanceOf(PublishReplyError);

    expect(googleApiPutJson).not.toHaveBeenCalled();
    const row = await Review.findById(reviewId).lean();
    expect(row?.publishClaimOwner).toBe("instance:fresh");
    expect(row?.replyComment || "").toBe("");
  });

  it("still requires confirmReplace when a reply already exists", async () => {
    await Review.updateOne(
      { _id: reviewId },
      { $set: { replyComment: "Existing reply" } }
    );

    await expect(
      publishReviewReply({
        orgId: String(orgId),
        reviewId: String(reviewId),
        comment: "Replacement",
        confirmReplace: false,
        claimOwner: "instance:a",
        bypassInProcessGuard: true,
      })
    ).rejects.toMatchObject({
      code: "needs_replace_confirmation",
      status: 409,
    });
    expect(googleApiPutJson).not.toHaveBeenCalled();
  });
});
