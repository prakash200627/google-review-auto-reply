import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireAuthMock,
  resolveScopeMock,
  listVisibleMock,
  connectMock,
  businessFindMock,
  groupFindMock,
  queryInboxMock,
  countMetricsMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveScopeMock: vi.fn(),
  listVisibleMock: vi.fn(),
  connectMock: vi.fn(),
  businessFindMock: vi.fn(),
  groupFindMock: vi.fn(),
  queryInboxMock: vi.fn(),
  countMetricsMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireAuthUser: requireAuthMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/auth/reviewsScope", () => ({
  resolveReviewsBusinessScope: resolveScopeMock,
}));

vi.mock("@/lib/auth/visibleLocations", () => ({
  listVisibleLocationsForUser: listVisibleMock,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: { find: businessFindMock },
}));

vi.mock("@/models/BusinessGroup", () => ({
  BusinessGroup: { find: groupFindMock },
}));

vi.mock("@/lib/reviews/queryInbox", () => ({
  queryReviewInbox: queryInboxMock,
  countReviewInboxMetrics: countMetricsMock,
}));

import { GET as inboxGet } from "@/app/api/reviews/inbox/route";

const ORG = new mongoose.Types.ObjectId().toString();
const BIZ_A = new mongoose.Types.ObjectId().toString();
const BIZ_OTHER = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();

describe("GET /api/reviews/inbox organization scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });
    businessFindMock.mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [
            { _id: BIZ_A, name: "In org", groupId: null, replyMode: "manual" },
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
    listVisibleMock.mockResolvedValue([]);
    queryInboxMock.mockResolvedValue({
      reviews: [],
      total: 0,
      page: 1,
      pageSize: 25,
    });
    countMetricsMock.mockResolvedValue({
      total: 0,
      unreplied: 0,
      draftsPending: 0,
      published: 0,
    });
  });

  it("returns org_required when SA has no active organization", async () => {
    resolveScopeMock.mockResolvedValue({
      ok: false,
      status: 403,
      code: "org_required",
      message: "Select an active organization",
      businessIds: [],
      orgId: null,
    });

    const res = await inboxGet(
      new Request("http://localhost/api/reviews/inbox")
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("org_required");
    expect(queryInboxMock).not.toHaveBeenCalled();
  });

  it("passes only org-scoped business ids into the inbox query", async () => {
    resolveScopeMock.mockResolvedValue({
      ok: true,
      orgId: ORG,
      businessIds: [BIZ_A],
    });

    const res = await inboxGet(
      new Request(
        `http://localhost/api/reviews/inbox?businessId=${BIZ_OTHER}&includeMetrics=1`
      )
    );
    expect(res.status).toBe(200);
    expect(queryInboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessIds: [BIZ_A],
        businessId: BIZ_OTHER,
      })
    );
    // Cross-org businessId is still passed through, but resolveScopeIds
    // inside queryReviewInbox will empty the result when not in allowed set.
    const body = await res.json();
    expect(body.orgId).toBe(ORG);
    expect(body.filters.businesses).toHaveLength(1);
    expect(body.filters.businesses[0].id).toBe(BIZ_A);
  });

  it("BA scope uses assignment ids from resolveReviewsBusinessScope", async () => {
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "business_owner",
        email: "ba@example.com",
        businessIds: [BIZ_A],
      },
    });
    resolveScopeMock.mockResolvedValue({
      ok: true,
      orgId: ORG,
      businessIds: [BIZ_A],
    });

    const res = await inboxGet(
      new Request("http://localhost/api/reviews/inbox")
    );
    expect(res.status).toBe(200);
    expect(queryInboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessIds: [BIZ_A] })
    );
  });
});
