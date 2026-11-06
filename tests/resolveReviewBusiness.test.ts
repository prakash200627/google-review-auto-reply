import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  reviewFindOneMock,
  reviewUpdateOneMock,
  locationFindOneMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  reviewFindOneMock: vi.fn(),
  reviewUpdateOneMock: vi.fn(),
  locationFindOneMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Review", () => ({
  Review: {
    findOne: reviewFindOneMock,
    updateOne: reviewUpdateOneMock,
  },
}));

vi.mock("@/models/Location", () => ({
  Location: {
    findOne: locationFindOneMock,
  },
}));

import {
  LOCATION_UNASSIGNED_CODE,
  pickBusinessIdFromAssignment,
  resolveReviewBusinessId,
} from "@/lib/reviews/resolveReviewBusiness";

const ORG = new mongoose.Types.ObjectId().toString();
const REVIEW = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();

describe("pickBusinessIdFromAssignment", () => {
  it("prefers review businessId when present", () => {
    expect(pickBusinessIdFromAssignment(BIZ, null)).toBe(BIZ);
  });

  it("falls back to location businessId when review is null", () => {
    expect(pickBusinessIdFromAssignment(null, BIZ)).toBe(BIZ);
  });

  it("returns null when neither is assigned", () => {
    expect(pickBusinessIdFromAssignment(null, null)).toBeNull();
    expect(pickBusinessIdFromAssignment(undefined, "")).toBeNull();
  });

  it("ignores invalid object ids", () => {
    expect(pickBusinessIdFromAssignment("not-an-id", BIZ)).toBe(BIZ);
    expect(pickBusinessIdFromAssignment("not-an-id", "also-bad")).toBeNull();
  });
});

describe("resolveReviewBusinessId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    reviewUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
  });

  it("returns review.businessId when already set", async () => {
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: BIZ,
          locationId: LOC,
        }),
      }),
    });
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ businessId: BIZ }),
      }),
    });

    const result = await resolveReviewBusinessId({
      reviewId: REVIEW,
      orgId: ORG,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.businessId).toBe(BIZ);
      expect(result.source).toBe("review");
      expect(result.healed).toBe(false);
    }
    expect(reviewUpdateOneMock).not.toHaveBeenCalled();
  });

  it("falls back to location.businessId and heals stale review rows", async () => {
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: null,
          locationId: LOC,
        }),
      }),
    });
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ businessId: BIZ }),
      }),
    });

    const result = await resolveReviewBusinessId({
      reviewId: REVIEW,
      orgId: ORG,
      heal: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.businessId).toBe(BIZ);
      expect(result.source).toBe("location");
      expect(result.healed).toBe(true);
    }
    expect(reviewUpdateOneMock).toHaveBeenCalledWith(
      { _id: REVIEW, orgId: ORG, businessId: null },
      { $set: { businessId: BIZ } }
    );
  });

  it("returns actionable location_unassigned when neither is linked", async () => {
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: null,
          locationId: LOC,
        }),
      }),
    });
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ businessId: null }),
      }),
    });

    const result = await resolveReviewBusinessId({
      reviewId: REVIEW,
      orgId: ORG,
      heal: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(LOCATION_UNASSIGNED_CODE);
      expect(result.message).toMatch(/Admin → Businesses/);
    }
    expect(reviewUpdateOneMock).not.toHaveBeenCalled();
  });
});
