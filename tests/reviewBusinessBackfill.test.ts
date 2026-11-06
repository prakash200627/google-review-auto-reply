import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  locationFindMock,
  reviewUpdateManyMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  locationFindMock: vi.fn(),
  reviewUpdateManyMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Location", () => ({
  Location: {
    find: locationFindMock,
  },
}));

vi.mock("@/models/Review", () => ({
  Review: {
    updateMany: reviewUpdateManyMock,
  },
}));

vi.mock("@/models/Business", () => ({
  Business: {},
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: {},
}));

import {
  clearReviewBusinessIdsForLocations,
  syncReviewBusinessIdsForLocations,
} from "@/lib/business/stats";

const BIZ = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();
const LOC_A = new mongoose.Types.ObjectId();
const LOC_B = new mongoose.Types.ObjectId();

describe("review businessId backfill on assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    reviewUpdateManyMock.mockResolvedValue({ modifiedCount: 2 });
  });

  it("backfills only reviews for locations currently assigned to the business", async () => {
    locationFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: LOC_A }],
      }),
    });

    const modified = await syncReviewBusinessIdsForLocations({
      businessId: BIZ,
      locationIds: [String(LOC_A), String(LOC_B)],
    });

    expect(locationFindMock).toHaveBeenCalledWith({
      _id: { $in: [String(LOC_A), String(LOC_B)] },
      businessId: BIZ,
    });
    expect(reviewUpdateManyMock).toHaveBeenCalledWith(
      { locationId: { $in: [LOC_A] } },
      { $set: { businessId: BIZ } }
    );
    expect(modified).toBe(2);
  });

  it("does not invent ownership when no locations are assigned to the business", async () => {
    locationFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [],
      }),
    });

    const modified = await syncReviewBusinessIdsForLocations({
      businessId: BIZ,
      locationIds: [String(LOC_A)],
    });
    expect(modified).toBe(0);
    expect(reviewUpdateManyMock).not.toHaveBeenCalled();
  });

  it("clears review.businessId on reassignment removal", async () => {
    reviewUpdateManyMock.mockResolvedValue({ modifiedCount: 1 });
    const modified = await clearReviewBusinessIdsForLocations({
      businessId: BIZ,
      locationIds: [String(LOC_A)],
    });
    expect(reviewUpdateManyMock).toHaveBeenCalledWith(
      {
        businessId: BIZ,
        locationId: { $in: [String(LOC_A)] },
      },
      { $set: { businessId: null } }
    );
    expect(modified).toBe(1);
  });

  it("rejects invalid ids without writing", async () => {
    expect(
      await syncReviewBusinessIdsForLocations({
        businessId: "bad",
        locationIds: [String(LOC_A)],
      })
    ).toBe(0);
    expect(
      await clearReviewBusinessIdsForLocations({
        businessId: OTHER,
        locationIds: ["bad"],
      })
    ).toBe(0);
    expect(reviewUpdateManyMock).not.toHaveBeenCalled();
  });
});
