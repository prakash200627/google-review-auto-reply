import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  locationCountMock,
  locationFindMock,
  reviewCountMock,
  reviewAggregateMock,
  googleFindOneMock,
  autoPublishCountMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  locationCountMock: vi.fn(),
  locationFindMock: vi.fn(),
  reviewCountMock: vi.fn(),
  reviewAggregateMock: vi.fn(),
  googleFindOneMock: vi.fn(),
  autoPublishCountMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Location", () => ({
  Location: {
    countDocuments: locationCountMock,
    find: locationFindMock,
  },
}));

vi.mock("@/models/Review", () => ({
  Review: {
    countDocuments: reviewCountMock,
    aggregate: reviewAggregateMock,
  },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: {
    findOne: googleFindOneMock,
  },
}));

vi.mock("@/models/AutoPublishJob", () => ({
  AutoPublishJob: {
    countDocuments: autoPublishCountMock,
  },
}));

import { getDashboardStats } from "@/lib/dashboard/stats";

const ORG = new mongoose.Types.ObjectId().toString();
const USER_ID = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId();

function mockGoogleActive() {
  googleFindOneMock.mockReturnValue({
    select: () => ({
      lean: async () => ({ status: "active" }),
    }),
  });
}

/**
 * Promise.all order in getDashboardStats:
 * locationCount, published(tronx), googleSynced, reviewCount, aggregate,
 * locationFind, google, failed, jobDrafts, reviewDrafts
 */
function mockReviewCounts(values: number[]) {
  let i = 0;
  reviewCountMock.mockImplementation(async () => values[i++] ?? 0);
}

describe("getDashboardStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    reviewAggregateMock.mockResolvedValue([]);
    autoPublishCountMock.mockResolvedValue(0);
    locationFindMock.mockReturnValue({
      select: () => ({
        limit: () => ({
          lean: async () => [],
        }),
        lean: async () => [],
      }),
    });
    mockGoogleActive();
  });

  it("returns zeros without querying when org or user is missing", async () => {
    await expect(
      getDashboardStats({ orgId: null, user: null })
    ).resolves.toMatchObject({
      connectedLocations: 0,
      pendingReviews: 0,
      publishedReplies: 0,
      googleSyncedReplies: 0,
      reviewCount: 0,
      averageRating: null,
    });
    expect(connectMock).not.toHaveBeenCalled();
    expect(locationCountMock).not.toHaveBeenCalled();
  });

  it("counts TRONX-published separately from google-synced replies", async () => {
    locationCountMock.mockResolvedValue(3);
    // published, synced, total, failed, reviewDrafts
    mockReviewCounts([5, 2, 12, 1, 0]);
    reviewAggregateMock.mockResolvedValue([{ _id: null, avg: 4.25, n: 8 }]);
    locationFindMock.mockReturnValue({
      select: () => ({
        limit: () => ({
          lean: async () => [
            { title: "A", googleLocationName: "accounts/1/locations/1" },
            { title: "B", googleLocationName: "accounts/1/locations/2" },
          ],
        }),
      }),
    });

    await expect(
      getDashboardStats({
        orgId: ORG,
        user: {
          userId: USER_ID,
          role: "superadmin",
          email: "admin@example.com",
          businessIds: [],
        },
      })
    ).resolves.toEqual({
      connectedLocations: 3,
      pendingReviews: 5, // 12 - 5 - 2
      publishedReplies: 5,
      googleSyncedReplies: 2,
      reviewCount: 12,
      averageRating: 4.3,
      locationTitle: null,
      googleConnectionStatus: "connected",
      draftsAwaitingApproval: 0,
      failedReplies: 1,
    });

    expect(locationCountMock).toHaveBeenCalledWith({ orgId: ORG });
    expect(autoPublishCountMock).not.toHaveBeenCalled();
    const publishedFilter = reviewCountMock.mock.calls[0]?.[0] as {
      $or?: unknown;
    };
    expect(publishedFilter.$or).toBeTruthy();
  });

  it("scopes owner metrics to assigned locations only", async () => {
    locationFindMock
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [{ _id: LOC }],
        }),
      })
      .mockReturnValueOnce({
        select: () => ({
          limit: () => ({
            lean: async () => [
              {
                title: "Native South",
                googleLocationName: "accounts/1/locations/1",
              },
            ],
          }),
        }),
      });
    locationCountMock.mockResolvedValue(1);
    mockReviewCounts([2, 0, 4, 0, 0]);
    reviewAggregateMock.mockResolvedValue([{ _id: null, avg: 5, n: 2 }]);

    await expect(
      getDashboardStats({
        orgId: ORG,
        user: {
          userId: USER_ID,
          role: "business_owner",
          email: "owner@example.com",
          businessIds: [BIZ],
        },
      })
    ).resolves.toEqual({
      connectedLocations: 1,
      pendingReviews: 2,
      publishedReplies: 2,
      googleSyncedReplies: 0,
      reviewCount: 4,
      averageRating: 5,
      locationTitle: "Native South",
      googleConnectionStatus: "connected",
      draftsAwaitingApproval: 0,
      failedReplies: 0,
    });
  });

  it("scopes by businessId when provided after authorization", async () => {
    locationCountMock.mockResolvedValue(1);
    mockReviewCounts([1, 0, 3, 2, 1]);
    autoPublishCountMock.mockResolvedValue(4);
    reviewAggregateMock.mockResolvedValue([]);
    locationFindMock.mockReturnValue({
      select: () => ({
        limit: () => ({
          lean: async () => [
            { title: "", googleLocationName: "accounts/1/locations/9" },
          ],
        }),
      }),
    });
    googleFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    await expect(
      getDashboardStats({
        orgId: ORG,
        user: {
          userId: USER_ID,
          role: "business_owner",
          email: "owner@example.com",
          businessIds: [BIZ],
        },
        businessId: BIZ,
      })
    ).resolves.toMatchObject({
      connectedLocations: 1,
      reviewCount: 3,
      pendingReviews: 2,
      publishedReplies: 1,
      googleSyncedReplies: 0,
      averageRating: null,
      locationTitle: "accounts/1/locations/9",
      googleConnectionStatus: "missing",
      draftsAwaitingApproval: 5, // 4 jobs + 1 review draft
      failedReplies: 2,
    });

    expect(autoPublishCountMock).toHaveBeenCalledWith({
      businessId: BIZ,
      status: "awaiting_approval",
    });
  });
});
