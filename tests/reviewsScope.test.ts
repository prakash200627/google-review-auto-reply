import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const {
  connectMock,
  businessFindMock,
  listActiveMock,
  resolveOrgMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  businessFindMock: vi.fn(),
  listActiveMock: vi.fn(),
  resolveOrgMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: { find: businessFindMock },
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
  resolveAuthorizedOrgId: resolveOrgMock,
  assertSuperAdminActiveOrgMatches: vi.fn(),
}));

import { resolveReviewsBusinessScope } from "@/lib/auth/reviewsScope";

const ORG = new mongoose.Types.ObjectId().toString();
const BIZ_A = new mongoose.Types.ObjectId().toString();
const BIZ_B = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();

describe("resolveReviewsBusinessScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("BA uses assignment-based active businesses", async () => {
    listActiveMock.mockResolvedValue([BIZ_A]);
    resolveOrgMock.mockResolvedValue(ORG);

    const result = await resolveReviewsBusinessScope({
      userId: USER,
      role: "business_owner",
      email: "ba@example.com",
      businessIds: [BIZ_A],
      groupIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.businessIds).toEqual([BIZ_A]);
    expect(listActiveMock).toHaveBeenCalled();
    expect(businessFindMock).not.toHaveBeenCalled();
  });

  it("SA without active org returns org_required", async () => {
    resolveOrgMock.mockResolvedValue(null);

    const result = await resolveReviewsBusinessScope({
      userId: USER,
      role: "superadmin",
      email: "sa@example.com",
      businessIds: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("org_required");
    expect(result.businessIds).toEqual([]);
  });

  it("SA with active org only returns businesses in that org", async () => {
    resolveOrgMock.mockResolvedValue(ORG);
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: BIZ_A }, { _id: BIZ_B }],
      }),
    });

    const result = await resolveReviewsBusinessScope({
      userId: USER,
      role: "superadmin",
      email: "sa@example.com",
      businessIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orgId).toBe(ORG);
    expect(result.businessIds).toEqual([BIZ_A, BIZ_B]);
    expect(businessFindMock).toHaveBeenCalledWith({
      orgId: expect.any(mongoose.Types.ObjectId),
    });
    expect(listActiveMock).not.toHaveBeenCalled();
  });
});

describe("Reviews inbox / page org-scope contracts", () => {
  it("inbox route uses resolveReviewsBusinessScope", () => {
    const src = readFileSync(
      join(process.cwd(), "app/api/reviews/inbox/route.ts"),
      "utf8"
    );
    expect(src).toMatch(/resolveReviewsBusinessScope/);
    expect(src).not.toMatch(/listActiveBusinessIdsForUser/);
  });

  it("reviews page uses resolveReviewsBusinessScope and denies cross-org business URLs", () => {
    const src = readFileSync(
      join(process.cwd(), "app/orm/reviews/page.tsx"),
      "utf8"
    );
    expect(src).toMatch(/resolveReviewsBusinessScope/);
    expect(src).toMatch(/different organization/);
    expect(src).toMatch(/activeOrgId/);
  });

  it("ReviewsWorkspace clears state when activeOrgId changes", () => {
    const src = readFileSync(
      join(process.cwd(), "components/reviews/ReviewsWorkspace.tsx"),
      "utf8"
    );
    expect(src).toMatch(/activeOrgId/);
    expect(src).toMatch(/lastOrgIdRef/);
    expect(src).toMatch(/EMPTY_REVIEWS_FILTERS/);
  });
});
