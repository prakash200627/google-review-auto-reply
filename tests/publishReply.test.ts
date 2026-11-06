import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  reviewFindOneMock,
  reviewFindOneAndUpdateMock,
  reviewUpdateOneMock,
  locationFindOneMock,
  businessFindByIdMock,
  loadBusinessPlanMock,
  getTokenMock,
  putJsonMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  reviewFindOneMock: vi.fn(),
  reviewFindOneAndUpdateMock: vi.fn(),
  reviewUpdateOneMock: vi.fn(),
  locationFindOneMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  loadBusinessPlanMock: vi.fn(),
  getTokenMock: vi.fn(),
  putJsonMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Review", () => ({
  Review: {
    findOne: reviewFindOneMock,
    findOneAndUpdate: reviewFindOneAndUpdateMock,
    updateOne: reviewUpdateOneMock,
  },
}));

vi.mock("@/models/Location", () => ({
  Location: {
    findOne: locationFindOneMock,
  },
}));

vi.mock("@/models/Business", () => ({
  Business: { findById: businessFindByIdMock },
}));

vi.mock("@/lib/entitlements/enforce", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entitlements/enforce")>(
    "@/lib/entitlements/enforce"
  );
  return {
    ...actual,
    loadBusinessPlan: loadBusinessPlanMock,
  };
});

vi.mock("@/lib/google/accessToken", () => ({
  getValidAccessTokenForContext: getTokenMock,
}));

vi.mock("@/lib/google/gbpClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/gbpClient")>(
    "@/lib/google/gbpClient"
  );
  return {
    ...actual,
    googleApiPutJson: putJsonMock,
  };
});

import {
  prepareReplyForPublish,
  publishReviewReply,
  resetPublishInFlightForTests,
  validateReplyComment,
  GOOGLE_REPLY_MAX_BYTES,
} from "@/lib/google/publishReply";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { PLAN_CATALOG } from "@/lib/entitlements/plans";

const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();
const REVIEW_ID = new mongoose.Types.ObjectId().toString();
const LOCATION_ID = new mongoose.Types.ObjectId().toString();
const BIZ_ID = new mongoose.Types.ObjectId().toString();
const GOOGLE_REVIEW_NAME =
  "accounts/111/locations/222/reviews/review-abc";

describe("validateReplyComment", () => {
  it("rejects empty and oversized replies", () => {
    expect(() => validateReplyComment("")).toThrow(/empty/i);
    expect(() => validateReplyComment("   ")).toThrow(/empty/i);
    expect(() => validateReplyComment(null)).toThrow(/string/i);
    const oversized = "a".repeat(GOOGLE_REPLY_MAX_BYTES + 1);
    expect(() => validateReplyComment(oversized)).toThrow(/4096/);
  });

  it("trims valid replies", () => {
    expect(validateReplyComment("  Thanks!  ")).toBe("Thanks!");
  });
});

describe("prepareReplyForPublish", () => {
  it("sanitizes trailing DEMO markers before validation", () => {
    expect(prepareReplyForPublish("Thanks for visiting! — DEMO")).toBe(
      "Thanks for visiting!"
    );
    expect(prepareReplyForPublish("Thanks — SAMPLE — TEST")).toBe("Thanks");
  });

  it("rejects empty or DEMO-only final text", () => {
    expect(() => prepareReplyForPublish("DEMO")).toThrow(/empty/i);
    expect(() => prepareReplyForPublish("— DEMO")).toThrow(/empty/i);
    expect(() => prepareReplyForPublish("")).toThrow(/empty/i);
    expect(() => prepareReplyForPublish("WATERMARK")).toThrow(/empty/i);
  });
});

describe("publishReviewReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPublishInFlightForTests();
    connectMock.mockResolvedValue({});
    getTokenMock.mockResolvedValue("access-token");
    reviewUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    loadBusinessPlanMock.mockResolvedValue({
      businessId: BIZ_ID,
      plan: {
        code: "starter",
        displayName: "Starter",
        status: "active",
        features: PLAN_CATALOG.starter.features,
        limits: PLAN_CATALOG.starter.limits,
        usage: { aiDraftsThisPeriod: 0, periodStart: null },
        assignedAt: null,
        notes: "",
      },
    });
  });

  function mockOwnedReview(overrides: Record<string, unknown> = {}) {
    const doc = {
      _id: REVIEW_ID,
      orgId: ORG_A,
      locationId: LOCATION_ID,
      businessId: BIZ_ID,
      googleReviewName: GOOGLE_REVIEW_NAME,
      replyComment: "",
      publishClaimOwner: "pub:test",
      publishClaimExpiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
    reviewUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    reviewFindOneAndUpdateMock.mockReturnValue({
      exec: async () => doc,
    });
    // Lease re-check before Google PUT + not_found lookups.
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: REVIEW_ID }),
      }),
    });
    locationFindOneMock.mockReturnValue({
      exec: async () => ({
        _id: LOCATION_ID,
        orgId: ORG_A,
        googleLocationName: "accounts/111/locations/222",
        businessId: BIZ_ID,
      }),
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ_ID,
          active: true,
          status: "active",
        }),
      }),
    });
  }

  it("publishes a first-time reply via official updateReply PUT", async () => {
    mockOwnedReview();
    putJsonMock.mockResolvedValue({
      comment: "Thank you for visiting!",
      updateTime: "2024-06-01T12:00:00Z",
      reviewReplyState: "APPROVED",
    });

    const result = await publishReviewReply({
      orgId: ORG_A,
      reviewId: REVIEW_ID,
      comment: "Thank you for visiting!",
    });

    expect(putJsonMock).toHaveBeenCalledWith(
      "https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews/review-abc/reply",
      "access-token",
      { comment: "Thank you for visiting!" },
      expect.any(Function),
      { retry: false }
    );
    expect(result.replacedExisting).toBe(false);
    expect(result.replyComment).toBe("Thank you for visiting!");
    expect(reviewUpdateOneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: REVIEW_ID,
        orgId: ORG_A,
        publishClaimOwner: expect.any(String),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          replyComment: "Thank you for visiting!",
          replySource: "tronx_published",
        }),
      })
    );
  });

  it("requires confirmReplace before updating an existing reply", async () => {
    mockOwnedReview({ replyComment: "Old public reply" });

    await expect(
      publishReviewReply({
        orgId: ORG_A,
        reviewId: REVIEW_ID,
        comment: "New reply",
        confirmReplace: false,
      })
    ).rejects.toMatchObject({
      code: "needs_replace_confirmation",
      status: 409,
      existingReply: "Old public reply",
    });
    expect(putJsonMock).not.toHaveBeenCalled();
  });

  it("updates an existing reply after explicit confirmation", async () => {
    mockOwnedReview({ replyComment: "Old public reply" });
    putJsonMock.mockResolvedValue({
      comment: "Updated reply",
      updateTime: "2024-06-02T12:00:00Z",
      reviewReplyState: "APPROVED",
    });

    const result = await publishReviewReply({
      orgId: ORG_A,
      reviewId: REVIEW_ID,
      comment: "Updated reply",
      confirmReplace: true,
    });

    expect(result.replacedExisting).toBe(true);
    expect(result.replyComment).toBe("Updated reply");
    expect(putJsonMock).toHaveBeenCalledOnce();
  });

  it("returns not_found when the review is missing for the org", async () => {
    reviewFindOneAndUpdateMock.mockReturnValue({ exec: async () => null });
    reviewFindOneMock.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });

    await expect(
      publishReviewReply({
        orgId: ORG_A,
        reviewId: REVIEW_ID,
        comment: "Hello",
      })
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(putJsonMock).not.toHaveBeenCalled();
  });

  it("rejects cross-org review ids (isolation)", async () => {
    reviewFindOneAndUpdateMock.mockReturnValue({ exec: async () => null });
    reviewFindOneMock.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });

    await expect(
      publishReviewReply({
        orgId: ORG_B,
        reviewId: REVIEW_ID,
        comment: "Hello",
      })
    ).rejects.toMatchObject({ code: "not_found" });
    expect(putJsonMock).not.toHaveBeenCalled();
  });

  it("denies publish when plan is suspended", async () => {
    mockOwnedReview();
    loadBusinessPlanMock.mockResolvedValue({
      businessId: BIZ_ID,
      plan: {
        code: "starter",
        displayName: "Starter",
        status: "suspended",
        features: PLAN_CATALOG.starter.features,
        limits: PLAN_CATALOG.starter.limits,
        usage: { aiDraftsThisPeriod: 0, periodStart: null },
        assignedAt: null,
        notes: "",
      },
    });

    await expect(
      publishReviewReply({
        orgId: ORG_A,
        reviewId: REVIEW_ID,
        comment: "Thanks",
      })
    ).rejects.toMatchObject({ code: "plan_inactive", status: 403 });
    expect(putJsonMock).not.toHaveBeenCalled();
  });

  it("denies publish when business lifecycle is suspended", async () => {
    mockOwnedReview();
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          active: false,
          status: "suspended",
        }),
      }),
    });

    await expect(
      publishReviewReply({
        orgId: ORG_A,
        reviewId: REVIEW_ID,
        comment: "Thanks",
      })
    ).rejects.toMatchObject({
      code: "business_lifecycle_blocked",
      status: 403,
    });
    expect(putJsonMock).not.toHaveBeenCalled();
  });

  it("rejects concurrent claim (in_flight)", async () => {
    reviewFindOneAndUpdateMock.mockReturnValue({ exec: async () => null });
    reviewFindOneMock.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: REVIEW_ID }) }),
    });

    await expect(
      publishReviewReply({
        orgId: ORG_A,
        reviewId: REVIEW_ID,
        comment: "Thanks",
      })
    ).rejects.toMatchObject({ code: "in_flight", status: 409 });
  });

  it("maps Google API failures without marking published", async () => {
    mockOwnedReview();
    putJsonMock.mockRejectedValue(
      new GoogleBusinessApiError("denied", {
        code: "permission_denied",
        status: 403,
      })
    );

    await expect(
      publishReviewReply({
        orgId: ORG_A,
        reviewId: REVIEW_ID,
        comment: "Thanks",
      })
    ).rejects.toMatchObject({ code: "permission_denied" });

    const publishedCalls = reviewUpdateOneMock.mock.calls.filter((c) => {
      const set = c[1]?.$set;
      return set && set.replySource === "tronx_published";
    });
    expect(publishedCalls).toHaveLength(0);
  });

  it("sanitizes DEMO before sending to Google", async () => {
    mockOwnedReview();
    putJsonMock.mockResolvedValue({
      comment: "Clean reply",
      updateTime: "2024-06-01T12:00:00Z",
    });

    await publishReviewReply({
      orgId: ORG_A,
      reviewId: REVIEW_ID,
      comment: "Clean reply — DEMO",
    });

    expect(putJsonMock).toHaveBeenCalledWith(
      expect.any(String),
      "access-token",
      { comment: "Clean reply" },
      expect.any(Function),
      { retry: false }
    );
  });
});
