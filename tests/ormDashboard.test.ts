import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mongoose from "mongoose";

const {
  connectMock,
  businessFindByIdMock,
  businessFindMock,
  businessAggregateMock,
  groupFindByIdMock,
  groupFindMock,
  reviewCountMock,
  reviewAggregateMock,
  reviewFindMock,
  locationCountMock,
  locationFindMock,
  listActiveMock,
  assertOrgMatchMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  businessFindMock: vi.fn(),
  businessAggregateMock: vi.fn(),
  groupFindByIdMock: vi.fn(),
  groupFindMock: vi.fn(),
  reviewCountMock: vi.fn(),
  reviewAggregateMock: vi.fn(),
  reviewFindMock: vi.fn(),
  locationCountMock: vi.fn(),
  locationFindMock: vi.fn(),
  listActiveMock: vi.fn(),
  assertOrgMatchMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: {
    findById: businessFindByIdMock,
    find: businessFindMock,
    aggregate: businessAggregateMock,
  },
}));

vi.mock("@/models/BusinessGroup", () => ({
  BusinessGroup: {
    findById: groupFindByIdMock,
    find: groupFindMock,
  },
}));

vi.mock("@/models/Review", () => ({
  Review: {
    countDocuments: reviewCountMock,
    aggregate: reviewAggregateMock,
    find: reviewFindMock,
  },
}));

vi.mock("@/models/Location", () => ({
  Location: {
    countDocuments: locationCountMock,
    find: locationFindMock,
  },
}));

vi.mock("@/lib/auth/authorize", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/authorize")>(
    "@/lib/auth/authorize"
  );
  return {
    ...actual,
    listActiveBusinessIdsForUser: listActiveMock,
  };
});

vi.mock("@/lib/auth/resolveOrgContext", () => ({
  resolveAuthorizedOrgId: vi.fn(),
  assertSuperAdminActiveOrgMatches: assertOrgMatchMock,
}));

import {
  asAggregateReviewFilter,
  combinedAverageRating,
  getBusinessOrmDashboard,
  getGroupOrmDashboard,
  getOrmLandingChoices,
} from "@/lib/dashboard/ormDashboard";
import type { AuthUser } from "@/lib/auth/authorize";

const ORG = new mongoose.Types.ObjectId();
const BIZ_A = new mongoose.Types.ObjectId();
const BIZ_B = new mongoose.Types.ObjectId();
const BIZ_OTHER = new mongoose.Types.ObjectId();
const GROUP_A = new mongoose.Types.ObjectId();
const GROUP_B = new mongoose.Types.ObjectId();
const LOC = new mongoose.Types.ObjectId();

function saUser(): AuthUser {
  return {
    userId: new mongoose.Types.ObjectId().toString(),
    email: "sa@example.com",
    role: "superadmin",
    businessIds: [],
    groupIds: [],
  };
}

function baUser(opts: {
  businessIds?: string[];
  groupIds?: string[];
}): AuthUser {
  return {
    userId: new mongoose.Types.ObjectId().toString(),
    email: "ba@example.com",
    role: "business_owner",
    businessIds: opts.businessIds || [],
    groupIds: opts.groupIds || [],
  };
}

function leanFindById(doc: unknown) {
  return {
    select: () => ({
      lean: async () => doc,
    }),
  };
}

describe("asAggregateReviewFilter", () => {
  it("casts string businessId to ObjectId for aggregation $match", () => {
    const id = String(BIZ_A);
    const out = asAggregateReviewFilter({ businessId: id });
    expect(out.businessId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(out.businessId)).toBe(id);
  });

  it("casts $in string ids to ObjectIds", () => {
    const out = asAggregateReviewFilter({
      businessId: { $in: [String(BIZ_A), String(BIZ_B)] },
    });
    const list = (out.businessId as { $in: mongoose.Types.ObjectId[] }).$in;
    expect(list).toHaveLength(2);
    expect(list[0]).toBeInstanceOf(mongoose.Types.ObjectId);
  });
});

describe("combinedAverageRating", () => {
  it("weights by rating count across businesses", () => {
    expect(
      combinedAverageRating([
        { ratingSum: 20, ratingN: 4 }, // avg 5
        { ratingSum: 6, ratingN: 2 }, // avg 3
      ])
    ).toBe(4.3); // 26/6 = 4.333 → 4.3
  });

  it("returns null when no rated reviews", () => {
    expect(combinedAverageRating([{ ratingSum: 0, ratingN: 0 }])).toBeNull();
    expect(combinedAverageRating([])).toBeNull();
  });
});

describe("getBusinessOrmDashboard authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    listActiveMock.mockResolvedValue([String(BIZ_A)]);
    assertOrgMatchMock.mockResolvedValue({ ok: true, orgId: String(ORG) });
    reviewFindMock.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [],
          }),
        }),
      }),
    });
    locationFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    reviewAggregateMock.mockResolvedValue([]);
    reviewCountMock.mockResolvedValue(0);
    locationCountMock.mockResolvedValue(0);
  });

  it("allows SA to inspect any existing business", async () => {
    businessFindByIdMock.mockReturnValue(
      leanFindById({
        _id: BIZ_A,
        name: "Alpha",
        orgId: ORG,
        groupId: null,
        active: true,
        status: "active",
        brandVoice: "friendly",
        preferredLanguage: "English",
        replyToneNotes: "",
        replyMode: "manual",
        profile: {},
      })
    );
    groupFindByIdMock.mockReturnValue(leanFindById(null));

    const result = await getBusinessOrmDashboard(saUser(), String(BIZ_A));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.business.name).toBe("Alpha");
      expect(result.data.metrics.totalReviews).toBe(0);
      expect(result.data.metrics.averageRating).toBeNull();
      expect(result.data.reviewsHref).toContain(`businessId=${BIZ_A}`);
    }
  });

  it("allows BA for assigned business and aggregates metrics", async () => {
    businessFindByIdMock.mockReturnValue(
      leanFindById({
        _id: BIZ_A,
        name: "Assigned",
        orgId: ORG,
        groupId: null,
        active: true,
        status: "active",
        ownerUserId: null,
        brandVoice: "friendly",
        preferredLanguage: "English",
        replyToneNotes: "",
        replyMode: "manual",
        profile: { phone: "1" },
      })
    );
    reviewCountMock
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(3) // unanswered
      .mockResolvedValueOnce(2) // drafts
      .mockResolvedValueOnce(7) // published
      .mockResolvedValueOnce(1) // tronx
      .mockResolvedValueOnce(2) // google synced
      .mockResolvedValueOnce(0); // failed
    reviewAggregateMock
      .mockResolvedValueOnce([{ avg: 4.2, n: 10 }]) // averageRatingForFilter
      .mockResolvedValueOnce([
        { _id: 5, count: 6 },
        { _id: 4, count: 4 },
      ]) // distribution
      .mockResolvedValueOnce([]); // by location

    const result = await getBusinessOrmDashboard(
      baUser({ businessIds: [String(BIZ_A)] }),
      String(BIZ_A)
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.metrics.totalReviews).toBe(10);
      expect(result.data.metrics.unanswered).toBe(3);
      expect(result.data.metrics.draftsPending).toBe(2);
      expect(result.data.metrics.publishedReplies).toBe(7);
      expect(result.data.metrics.averageRating).toBe(4.2);
    }
  });

  it("denies BA for unassigned business", async () => {
    businessFindByIdMock.mockReturnValue(
      leanFindById({
        _id: BIZ_B,
        name: "Other",
        orgId: ORG,
        groupId: null,
        active: true,
        status: "active",
        ownerUserId: null,
      })
    );

    const result = await getBusinessOrmDashboard(
      baUser({ businessIds: [String(BIZ_A)] }),
      String(BIZ_B)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("rejects invalid business id", async () => {
    const result = await getBusinessOrmDashboard(saUser(), "not-an-id");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("returns 404 for missing business", async () => {
    businessFindByIdMock.mockReturnValue(leanFindById(null));
    const result = await getBusinessOrmDashboard(
      saUser(),
      String(new mongoose.Types.ObjectId())
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("denies SA when active org does not match the business org", async () => {
    businessFindByIdMock.mockReturnValue(
      leanFindById({
        _id: BIZ_A,
        name: "Alpha",
        orgId: ORG,
        groupId: null,
        active: true,
        status: "active",
        brandVoice: "friendly",
        preferredLanguage: "English",
        replyToneNotes: "",
        replyMode: "manual",
        profile: {},
      })
    );
    assertOrgMatchMock.mockResolvedValue({
      ok: false,
      status: 403,
      code: "org_mismatch",
      message: "org mismatch",
    });

    const result = await getBusinessOrmDashboard(saUser(), String(BIZ_A));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("org_mismatch");
    }
  });
});

describe("getGroupOrmDashboard authorization and isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    assertOrgMatchMock.mockResolvedValue({ ok: true, orgId: String(ORG) });
    reviewFindMock.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [],
          }),
        }),
      }),
    });
    locationFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    reviewAggregateMock.mockResolvedValue([]);
    reviewCountMock.mockResolvedValue(0);
    locationCountMock.mockResolvedValue(0);
  });

  it("allows SA and aggregates only member businesses", async () => {
    listActiveMock.mockResolvedValue([
      String(BIZ_A),
      String(BIZ_B),
      String(BIZ_OTHER),
    ]);
    groupFindByIdMock.mockReturnValue(
      leanFindById({
        _id: GROUP_A,
        name: "Group A",
        description: "",
        orgId: ORG,
        active: true,
      })
    );
    // members of GROUP_A only
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: BIZ_A }, { _id: BIZ_B }],
        sort: () => ({
          lean: async () => [
            {
              _id: BIZ_A,
              name: "A",
              active: true,
              status: "active",
              groupId: GROUP_A,
            },
            {
              _id: BIZ_B,
              name: "B",
              active: true,
              status: "active",
              groupId: GROUP_A,
            },
          ],
        }),
      }),
    });
    reviewCountMock
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(4);
    reviewAggregateMock
      .mockResolvedValueOnce([
        {
          _id: BIZ_A,
          totalReviews: 3,
          unanswered: 1,
          draftsPending: 0,
          publishedReplies: 2,
          ratingSum: 15,
          ratingN: 3,
        },
        {
          _id: BIZ_B,
          totalReviews: 2,
          unanswered: 0,
          draftsPending: 0,
          publishedReplies: 2,
          ratingSum: 8,
          ratingN: 2,
        },
      ])
      .mockResolvedValueOnce([{ avg: 4.6, n: 5 }])
      .mockResolvedValueOnce([]);

    const result = await getGroupOrmDashboard(saUser(), String(GROUP_A));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.metrics.businessCount).toBe(2);
      expect(result.data.metrics.totalReviews).toBe(5);
      expect(result.data.metrics.averageRating).toBe(4.6);
      expect(result.data.businesses).toHaveLength(2);
      expect(result.data.reviewsHref).toContain(`groupId=${GROUP_A}`);
      // BIZ_OTHER must not appear
      expect(
        result.data.businesses.every(
          (b) => b.businessId !== String(BIZ_OTHER)
        )
      ).toBe(true);
    }
  });

  it("denies BA for unassigned group", async () => {
    groupFindByIdMock.mockReturnValue(
      leanFindById({
        _id: GROUP_B,
        name: "Other group",
        orgId: ORG,
        active: true,
      })
    );
    const result = await getGroupOrmDashboard(
      baUser({ businessIds: [String(BIZ_A)], groupIds: [String(GROUP_A)] }),
      String(GROUP_B)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("BA group scope intersects membership with authorized businesses", async () => {
    listActiveMock.mockResolvedValue([String(BIZ_A)]);
    groupFindByIdMock.mockReturnValue(
      leanFindById({
        _id: GROUP_A,
        name: "Group A",
        description: "",
        orgId: ORG,
        active: true,
      })
    );
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: BIZ_A }, { _id: BIZ_B }],
        sort: () => ({
          lean: async () => [
            {
              _id: BIZ_A,
              name: "A",
              active: true,
              status: "active",
              groupId: GROUP_A,
            },
          ],
        }),
      }),
    });

    const result = await getGroupOrmDashboard(
      baUser({
        businessIds: [String(BIZ_A)],
        groupIds: [String(GROUP_A)],
      }),
      String(GROUP_A)
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.metrics.businessCount).toBe(1);
      expect(result.data.businesses.map((b) => b.businessId)).toEqual([
        String(BIZ_A),
      ]);
    }
  });

  it("handles empty groups without fabricating ratings", async () => {
    listActiveMock.mockResolvedValue([]);
    groupFindByIdMock.mockReturnValue(
      leanFindById({
        _id: GROUP_A,
        name: "Empty",
        description: "",
        orgId: ORG,
        active: true,
      })
    );
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [],
        sort: () => ({ lean: async () => [] }),
      }),
    });

    const result = await getGroupOrmDashboard(saUser(), String(GROUP_A));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.metrics.businessCount).toBe(0);
      expect(result.data.metrics.totalReviews).toBe(0);
      expect(result.data.metrics.averageRating).toBeNull();
      expect(result.data.recentReviews).toEqual([]);
    }
  });

  it("rejects invalid group id", async () => {
    const result = await getGroupOrmDashboard(saUser(), "bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});

describe("getOrmLandingChoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("SA with org sees two businesses and one group in that org only", async () => {
    const orgId = String(ORG);
    businessFindMock.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [
            { _id: BIZ_A, name: "Alpha", groupId: GROUP_A },
            { _id: BIZ_B, name: "Beta", groupId: GROUP_A },
          ],
        }),
      }),
    });
    groupFindMock.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [{ _id: GROUP_A, name: "Demo" }],
        }),
      }),
    });
    businessAggregateMock.mockResolvedValue([{ _id: GROUP_A, n: 2 }]);

    const choices = await getOrmLandingChoices(saUser(), { orgId });
    expect(choices.needsOrgSelection).toBe(false);
    expect(choices.orgId).toBe(orgId);
    expect(choices.businesses).toEqual([
      { id: String(BIZ_A), name: "Alpha", groupId: String(GROUP_A) },
      { id: String(BIZ_B), name: "Beta", groupId: String(GROUP_A) },
    ]);
    expect(choices.groups).toEqual([
      { id: String(GROUP_A), name: "Demo", businessCount: 2 },
    ]);
    expect(businessFindMock).toHaveBeenCalledWith({
      orgId: expect.any(mongoose.Types.ObjectId),
    });
    expect(listActiveMock).not.toHaveBeenCalled();
  });

  it("SA without org requires organization selection and returns empty choices", async () => {
    const choices = await getOrmLandingChoices(saUser(), { orgId: null });
    expect(choices.needsOrgSelection).toBe(true);
    expect(choices.businesses).toEqual([]);
    expect(choices.groups).toEqual([]);
    expect(businessFindMock).not.toHaveBeenCalled();
    expect(groupFindMock).not.toHaveBeenCalled();
  });

  it("SA with org and no groups returns empty groups without inventing membership", async () => {
    businessFindMock.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [
            { _id: BIZ_A, name: "Lone", groupId: null },
          ],
        }),
      }),
    });
    groupFindMock.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [],
        }),
      }),
    });

    const choices = await getOrmLandingChoices(saUser(), {
      orgId: String(ORG),
    });
    expect(choices.businesses).toHaveLength(1);
    expect(choices.groups).toEqual([]);
    expect(choices.singleBusinessId).toBe(String(BIZ_A));
    expect(businessAggregateMock).not.toHaveBeenCalled();
  });

  it("BA only sees assigned businesses and groups", async () => {
    listActiveMock.mockResolvedValue([String(BIZ_A)]);
    businessFindMock.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [
            { _id: BIZ_A, name: "Mine", groupId: GROUP_A },
          ],
        }),
      }),
    });
    groupFindMock.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [{ _id: GROUP_A, name: "G" }],
        }),
      }),
    });
    businessAggregateMock.mockResolvedValue([{ _id: GROUP_A, n: 1 }]);

    const choices = await getOrmLandingChoices(
      baUser({
        businessIds: [String(BIZ_A)],
        groupIds: [String(GROUP_A)],
      })
    );
    expect(choices.needsOrgSelection).toBe(false);
    expect(choices.businesses).toHaveLength(1);
    expect(choices.groups).toHaveLength(1);
    expect(choices.singleBusinessId).toBe(String(BIZ_A));
    expect(listActiveMock).toHaveBeenCalled();
  });

  it("BA with no assignments gets genuinely empty results", async () => {
    listActiveMock.mockResolvedValue([]);
    const choices = await getOrmLandingChoices(
      baUser({ businessIds: [], groupIds: [] })
    );
    expect(choices.businesses).toEqual([]);
    expect(choices.groups).toEqual([]);
    expect(choices.singleBusinessId).toBeNull();
    expect(businessFindMock).not.toHaveBeenCalled();
  });
});

describe("ORM dashboard routes and navigation", () => {
  it("creates dedicated business and group dashboard routes", () => {
    const biz = readFileSync(
      join(process.cwd(), "app/orm/business/[businessId]/page.tsx"),
      "utf8"
    );
    const group = readFileSync(
      join(process.cwd(), "app/orm/group/[groupId]/page.tsx"),
      "utf8"
    );
    expect(biz).toMatch(/getBusinessOrmDashboard/);
    expect(biz).toMatch(/Breadcrumbs/);
    expect(group).toMatch(/getGroupOrmDashboard/);
    expect(group).toMatch(/Per-business comparison/);
  });

  it("redirects legacy /orm?businessId= to dedicated dashboard", () => {
    const src = readFileSync(join(process.cwd(), "app/orm/page.tsx"), "utf8");
    expect(src).toMatch(/redirect\(`\/orm\/business\//);
    expect(src).toMatch(/OrmLandingClient/);
    expect(src).not.toMatch(/OwnerBusinessPanel/);
  });

  it("reviews page accepts groupId and businessId filters", () => {
    const src = readFileSync(
      join(process.cwd(), "app/orm/reviews/page.tsx"),
      "utf8"
    );
    expect(src).toMatch(/groupId/);
    expect(src).toMatch(/assertGroupAccess/);
    expect(src).toMatch(/initialGroupId/);
  });

  it("keeps ORM secondary nav simple (Overview + Reviews)", () => {
    const src = readFileSync(
      join(process.cwd(), "components/nav/navConfig.ts"),
      "utf8"
    );
    expect(src).toMatch(/href: "\/orm"/);
    expect(src).toMatch(/href: "\/orm\/reviews"/);
    expect(src).not.toMatch(/href: "\/orm\/business"/);
  });
});
