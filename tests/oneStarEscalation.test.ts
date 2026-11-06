import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const { connectMock, findOneMock, createMock, locationFindOneMock } =
  vi.hoisted(() => ({
    connectMock: vi.fn(),
    findOneMock: vi.fn(),
    createMock: vi.fn(),
    locationFindOneMock: vi.fn(),
  }));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/FakeReviewFlag", () => ({
  FakeReviewFlag: {
    findOne: findOneMock,
    create: createMock,
  },
}));

vi.mock("@/models/Location", () => ({
  Location: {
    findOne: locationFindOneMock,
  },
}));

import { escalateOneStarReview } from "@/lib/reviews/oneStarEscalation";

const REVIEW = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const ORG = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId().toString();

describe("one-star escalation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    findOneMock.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    createMock.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    locationFindOneMock.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
  });

  it("creates an open flag for a new 1★ review and never publishes", async () => {
    const result = await escalateOneStarReview({
      reviewId: REVIEW,
      businessId: BIZ,
      orgId: ORG,
      starRating: 1,
      comment: "Terrible",
    });
    expect(result.flagCreated).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.published).toBe(false);
    expect(result.reportedToGoogle).toBe(false);
    expect(createMock).toHaveBeenCalled();
  });

  it("resolves businessId from location when review businessId is null", async () => {
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ businessId: BIZ }),
      }),
    });

    const result = await escalateOneStarReview({
      reviewId: REVIEW,
      businessId: null,
      locationId: LOC,
      orgId: ORG,
      starRating: 1,
      comment: "Bad",
    });

    expect(result.flagCreated).toBe(true);
    expect(locationFindOneMock).toHaveBeenCalledWith({
      _id: LOC,
      orgId: ORG,
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, reviewId: REVIEW })
    );
  });

  it("skips escalation when location is also unassigned", async () => {
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ businessId: null }),
      }),
    });

    const result = await escalateOneStarReview({
      reviewId: REVIEW,
      businessId: null,
      locationId: LOC,
      orgId: ORG,
      starRating: 1,
    });

    expect(result.escalated).toBe(false);
    expect(result.riskReason).toBe("no_business_assignment");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("is idempotent when an open flag already exists", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: new mongoose.Types.ObjectId() }),
      }),
    });
    const result = await escalateOneStarReview({
      reviewId: REVIEW,
      businessId: BIZ,
      orgId: ORG,
      starRating: 1,
    });
    expect(result.flagCreated).toBe(false);
    expect(result.escalated).toBe(true);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does not escalate non-one-star ratings", async () => {
    const result = await escalateOneStarReview({
      reviewId: REVIEW,
      businessId: BIZ,
      orgId: ORG,
      starRating: 2,
    });
    expect(result.escalated).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });
});
