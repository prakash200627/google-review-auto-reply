import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireOrgUserMock,
  assertReviewAccessMock,
  assertBusinessAccessMock,
  requireAuthMock,
  requireSuperAdminMock,
  resolveBusinessMock,
  createFlagMock,
  findFlagMock,
  connectMock,
  featureEnabledMock,
  toPlanSnapshotMock,
  auditMock,
} = vi.hoisted(() => ({
  requireOrgUserMock: vi.fn(),
  assertReviewAccessMock: vi.fn(),
  assertBusinessAccessMock: vi.fn(),
  requireAuthMock: vi.fn(),
  requireSuperAdminMock: vi.fn(),
  resolveBusinessMock: vi.fn(),
  createFlagMock: vi.fn(),
  findFlagMock: vi.fn(),
  connectMock: vi.fn(),
  featureEnabledMock: vi.fn(),
  toPlanSnapshotMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("@/lib/auth/googleRouteAuth", () => ({
  requireOrgAndUserAccess: requireOrgUserMock,
  assertUserCanAccessReview: assertReviewAccessMock,
  isOrgUserResult: (
    value: { orgId: string; user: unknown } | { response: NextResponse }
  ) => "orgId" in value && "user" in value,
}));

vi.mock("@/lib/auth/authorize", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/authorize")>(
    "@/lib/auth/authorize"
  );
  return {
    ...actual,
    assertBusinessAccess: assertBusinessAccessMock,
    requireAuthUser: requireAuthMock,
    requireSuperAdmin: requireSuperAdminMock,
    isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
      "user" in value,
  };
});

vi.mock("@/lib/reviews/resolveReviewBusiness", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/reviews/resolveReviewBusiness")
  >("@/lib/reviews/resolveReviewBusiness");
  return {
    ...actual,
    resolveReviewBusinessId: resolveBusinessMock,
  };
});

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/FakeReviewFlag", () => ({
  FakeReviewFlag: {
    create: createFlagMock,
    findOne: findFlagMock,
    find: vi.fn().mockReturnValue({
      sort: () => ({ lean: async () => [] }),
    }),
  },
  FAKE_REVIEW_FLAG_STATUSES: [
    "open",
    "investigating",
    "confirmed_suspicious",
    "dismissed",
  ],
}));

vi.mock("@/models/Review", () => ({
  Review: {
    findById: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock("@/lib/entitlements/featureMap", () => ({
  featureEnabled: featureEnabledMock,
}));

vi.mock("@/lib/entitlements/enforce", () => ({
  toPlanSnapshot: toPlanSnapshotMock,
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditMock,
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: () => ({ ok: true as const }),
}));

import { POST as flagPost } from "@/app/api/reviews/[reviewId]/flag/route";

const ORG = new mongoose.Types.ObjectId().toString();
const REVIEW = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const USER = {
  userId: new mongoose.Types.ObjectId().toString(),
  role: "superadmin" as const,
  email: "sa@example.com",
  businessIds: [] as string[],
};
const OWNER = {
  userId: new mongoose.Types.ObjectId().toString(),
  role: "business_owner" as const,
  email: "owner@example.com",
  businessIds: [BIZ],
};

describe("POST /api/reviews/[reviewId]/flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    requireOrgUserMock.mockResolvedValue({ orgId: ORG, user: USER });
    assertReviewAccessMock.mockResolvedValue({ ok: true });
    assertBusinessAccessMock.mockResolvedValue({
      ok: true,
      business: { plan: { code: "growth" } },
    });
    featureEnabledMock.mockReturnValue(true);
    toPlanSnapshotMock.mockReturnValue({ code: "growth" });
    createFlagMock.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      status: "open",
      reason: "Suspicious",
    });
  });

  it("flags when review.businessId is set", async () => {
    resolveBusinessMock.mockResolvedValue({
      ok: true,
      businessId: BIZ,
      source: "review",
      reviewId: REVIEW,
      locationId: new mongoose.Types.ObjectId().toString(),
      healed: false,
    });

    const res = await flagPost(
      new Request(`http://localhost/api/reviews/${REVIEW}/flag`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ reason: "Looks fake" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW }) }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(createFlagMock).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, reviewId: REVIEW })
    );
    expect(assertBusinessAccessMock).toHaveBeenCalledWith(USER, BIZ);
  });

  it("flags via location.businessId when review.businessId is null (healed)", async () => {
    resolveBusinessMock.mockResolvedValue({
      ok: true,
      businessId: BIZ,
      source: "location",
      reviewId: REVIEW,
      locationId: new mongoose.Types.ObjectId().toString(),
      healed: true,
    });

    const res = await flagPost(
      new Request(`http://localhost/api/reviews/${REVIEW}/flag`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ reason: "Looks fake" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW }) }
    );
    expect(res.status).toBe(200);
    expect(resolveBusinessMock).toHaveBeenCalledWith({
      reviewId: REVIEW,
      orgId: ORG,
      heal: true,
    });
    expect(createFlagMock).toHaveBeenCalled();
  });

  it("returns actionable location_unassigned when location is not assigned", async () => {
    resolveBusinessMock.mockResolvedValue({
      ok: false,
      code: "location_unassigned",
      message:
        "This review's Google location is not assigned to a business. A Super Admin must assign the location under Admin → Businesses before this action can continue.",
    });

    const res = await flagPost(
      new Request(`http://localhost/api/reviews/${REVIEW}/flag`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ reason: "Looks fake" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW }) }
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe("location_unassigned");
    expect(body.message).toMatch(/Admin → Businesses/);
    expect(createFlagMock).not.toHaveBeenCalled();
  });

  it("scopes owner access through assertBusinessAccess", async () => {
    requireOrgUserMock.mockResolvedValue({ orgId: ORG, user: OWNER });
    resolveBusinessMock.mockResolvedValue({
      ok: true,
      businessId: BIZ,
      source: "review",
      reviewId: REVIEW,
      locationId: new mongoose.Types.ObjectId().toString(),
      healed: false,
    });
    assertBusinessAccessMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { success: false, code: "forbidden", message: "Denied" },
        { status: 403 }
      ),
    });

    const res = await flagPost(
      new Request(`http://localhost/api/reviews/${REVIEW}/flag`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ reason: "Looks fake" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW }) }
    );
    expect(res.status).toBe(403);
    expect(createFlagMock).not.toHaveBeenCalled();
  });
});
