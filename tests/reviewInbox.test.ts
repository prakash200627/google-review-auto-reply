import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  businessFindMock,
  reviewCountMock,
  reviewFindMock,
  flagFindMock,
  locationFindMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  businessFindMock: vi.fn(),
  reviewCountMock: vi.fn(),
  reviewFindMock: vi.fn(),
  flagFindMock: vi.fn(),
  locationFindMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: { find: businessFindMock },
}));

vi.mock("@/models/Review", () => ({
  Review: {
    countDocuments: reviewCountMock,
    find: reviewFindMock,
  },
}));

vi.mock("@/models/FakeReviewFlag", () => ({
  FakeReviewFlag: { find: flagFindMock },
}));

vi.mock("@/models/Location", () => ({
  Location: { find: locationFindMock },
}));

import {
  countReviewInboxMetrics,
  queryReviewInbox,
} from "@/lib/reviews/queryInbox";

const BIZ_A = new mongoose.Types.ObjectId().toString();
const BIZ_B = new mongoose.Types.ObjectId().toString();
const GROUP = new mongoose.Types.ObjectId().toString();
const LOC_A = new mongoose.Types.ObjectId();

describe("queryReviewInbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    flagFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    locationFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            _id: LOC_A,
            title: "Main Store",
            googleLocationName: "accounts/1/locations/1",
          },
        ],
      }),
    });
    reviewCountMock.mockResolvedValue(1);
    reviewFindMock.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: new mongoose.Types.ObjectId(),
                businessId: BIZ_A,
                locationId: LOC_A,
                reviewerDisplayName: "Sam",
                starRating: 5,
                comment: "Great",
                createTime: new Date(),
                updateTime: new Date(),
                replyComment: "",
                replyUpdateTime: null,
                replySource: "",
                draftText: "",
                draftStatus: "none",
                draftApproved: false,
                draftUpdatedAt: null,
              },
            ],
          }),
        }),
      }),
    });
  });

  it("returns empty when no authorized business ids", async () => {
    const result = await queryReviewInbox({ businessIds: [] });
    expect(result.total).toBe(0);
    expect(result.reviews).toEqual([]);
    expect(reviewFindMock).not.toHaveBeenCalled();
  });

  it("scopes by group via authorized businesses only", async () => {
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: new mongoose.Types.ObjectId(BIZ_A) }],
      }),
    });

    const result = await queryReviewInbox({
      businessIds: [BIZ_A, BIZ_B],
      groupId: GROUP,
      replyStatus: "unreplied",
    });

    expect(businessFindMock).toHaveBeenCalledWith({
      _id: { $in: [BIZ_A, BIZ_B] },
      groupId: GROUP,
    });
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].locationTitle).toBe("Main Store");
    expect(reviewCountMock).toHaveBeenCalled();
  });

  it("rejects unauthorized businessId filter", async () => {
    const result = await queryReviewInbox({
      businessIds: [BIZ_A],
      businessId: BIZ_B,
    });
    expect(result.total).toBe(0);
    expect(result.reviews).toEqual([]);
  });

  it("filters replyStatus=draft via draftStatus query", async () => {
    await queryReviewInbox({
      businessIds: [BIZ_A],
      replyStatus: "draft",
    });
    expect(reviewCountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: { $in: [BIZ_A] },
        draftStatus: { $in: ["generated", "edited"] },
      })
    );
  });

  it("filters replyStatus=approved via draftApproved query", async () => {
    await queryReviewInbox({
      businessIds: [BIZ_A],
      replyStatus: "approved",
    });
    expect(reviewFindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: { $in: [BIZ_A] },
        draftApproved: true,
        draftStatus: "approved",
      })
    );
  });

  it("filters replyStatus=drafts as unreplied drafts only", async () => {
    await queryReviewInbox({
      businessIds: [BIZ_A],
      replyStatus: "drafts",
    });
    expect(reviewCountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: { $in: [BIZ_A] },
        draftStatus: { $in: ["generated", "edited", "approved"] },
        $or: expect.any(Array),
      })
    );
  });

  it("filters by locationId and search q", async () => {
    await queryReviewInbox({
      businessIds: [BIZ_A],
      locationId: String(LOC_A),
      q: "great",
    });
    expect(reviewFindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: { $in: [BIZ_A] },
        locationId: String(LOC_A),
      })
    );
  });

  it("combines business, rating, and unreplied filters", async () => {
    await queryReviewInbox({
      businessIds: [BIZ_A, BIZ_B],
      businessId: BIZ_A,
      starRating: 3,
      replyStatus: "unreplied",
    });
    expect(reviewCountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: { $in: [BIZ_A] },
        starRating: 3,
        $or: expect.any(Array),
      })
    );
  });
});

describe("countReviewInboxMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    reviewCountMock.mockResolvedValue(3);
  });

  it("returns zeros without authorized businesses", async () => {
    await expect(
      countReviewInboxMetrics({ businessIds: [] })
    ).resolves.toEqual({
      total: 0,
      unreplied: 0,
      draftsPending: 0,
      published: 0,
    });
    expect(reviewCountMock).not.toHaveBeenCalled();
  });

  it("runs four scoped counts in parallel", async () => {
    const metrics = await countReviewInboxMetrics({
      businessIds: [BIZ_A],
    });
    expect(metrics).toEqual({
      total: 3,
      unreplied: 3,
      draftsPending: 3,
      published: 3,
    });
    expect(reviewCountMock).toHaveBeenCalledTimes(4);
  });
});
