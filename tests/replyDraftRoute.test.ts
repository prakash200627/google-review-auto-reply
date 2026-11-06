import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireOrgUserMock,
  assertReviewAccessMock,
  connectMock,
  findOneMock,
  updateOneMock,
  generateMock,
  isConfiguredMock,
  rateLimitMock,
  resolveBusinessMock,
} = vi.hoisted(() => ({
  requireOrgUserMock: vi.fn(),
  assertReviewAccessMock: vi.fn(),
  connectMock: vi.fn(),
  findOneMock: vi.fn(),
  updateOneMock: vi.fn(),
  generateMock: vi.fn(),
  isConfiguredMock: vi.fn(),
  rateLimitMock: vi.fn(),
  resolveBusinessMock: vi.fn(),
}));

vi.mock("@/lib/auth/googleRouteAuth", () => ({
  requireOrgAndUserAccess: requireOrgUserMock,
  assertUserCanAccessReview: assertReviewAccessMock,
  isOrgUserResult: (
    value: { orgId: string; user: unknown } | { response: NextResponse }
  ) => "orgId" in value && "user" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Review", () => ({
  Review: {
    findOne: findOneMock,
    updateOne: updateOneMock,
  },
}));

vi.mock("@/lib/ai/replyDraft", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/replyDraft")>(
    "@/lib/ai/replyDraft"
  );
  return {
    ...actual,
    generateReplyDraft: generateMock,
  };
});

vi.mock("@/lib/ai/openaiConfig", () => ({
  isOpenAiConfigured: isConfiguredMock,
}));

vi.mock("@/lib/ai/rateLimit", () => ({
  checkDraftRateLimit: rateLimitMock,
  checkSaUnassignedDraftRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  resetDraftRateLimitForTests: vi.fn(),
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: vi.fn(),
}));

vi.mock("@/lib/reviews/resolveReviewBusiness", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/reviews/resolveReviewBusiness")
  >("@/lib/reviews/resolveReviewBusiness");
  return {
    ...actual,
    resolveReviewBusinessId: resolveBusinessMock,
  };
});

vi.mock("@/lib/entitlements/enforce", () => ({
  tryReserveAiDraftQuota: vi.fn().mockResolvedValue(undefined),
  releaseAiDraftQuota: vi.fn().mockResolvedValue(undefined),
  EntitlementError: class EntitlementError extends Error {
    code: string;
    status: number;
    constructor(
      message: string,
      opts: { code: string; status: number }
    ) {
      super(message);
      this.code = opts.code;
      this.status = opts.status;
    }
  },
  entitlementErrorResponse: (err: { code: string; message: string; status: number }) =>
    NextResponse.json(
      { success: false, code: err.code, message: err.message },
      { status: err.status }
    ),
}));

vi.mock("@/models/Business", () => ({
  Business: {
    findById: vi.fn().mockReturnValue({
      select: () => ({
        lean: async () => ({
          brandVoice: "friendly",
          preferredLanguage: "English",
          active: true,
          status: "active",
        }),
      }),
    }),
  },
}));

import { PATCH, POST } from "@/app/api/reviews/[reviewId]/draft/route";

const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();
const REVIEW_ID = new mongoose.Types.ObjectId().toString();
const USER = {
  userId: new mongoose.Types.ObjectId().toString(),
  role: "superadmin" as const,
  email: "admin@example.com",
  businessIds: [] as string[],
};

describe("POST /api/reviews/[reviewId]/draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    isConfiguredMock.mockReturnValue(true);
    rateLimitMock.mockReturnValue({ allowed: true });
    requireOrgUserMock.mockResolvedValue({ orgId: ORG_A, user: USER });
    assertReviewAccessMock.mockResolvedValue({ ok: true });
    updateOneMock.mockResolvedValue({ acknowledged: true });
    // SA draft tests: unassigned location still allowed for Super Admin.
    resolveBusinessMock.mockResolvedValue({
      ok: false,
      code: "location_unassigned",
      message: "unassigned",
    });
  });

  it("generates a draft only for reviews owned by the current org", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          starRating: 5,
          comment: "Great food",
          reviewerDisplayName: "Sam",
          draftApproved: false,
          draftStatus: "none",
        }),
      }),
    });
    generateMock.mockResolvedValue({
      draft: "Thank you, Sam!",
      tone: "positive",
      model: "gpt-4o-mini",
    });

    const res = await POST(new Request("http://localhost/api/reviews/x/draft"), {
      params: Promise.resolve({ reviewId: REVIEW_ID }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      isDraft: true,
      draft: "Thank you, Sam!",
      tone: "positive",
      persisted: true,
      draftStatus: "generated",
    });
    expect(findOneMock).toHaveBeenCalledWith({
      _id: REVIEW_ID,
      orgId: ORG_A,
    });
    expect(updateOneMock).toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalledWith({
      starRating: 5,
      comment: "Great food",
      reviewerDisplayName: "Sam",
      brandVoice: "friendly",
      preferredLanguage: "English",
      replyToneNotes: "",
    });
  });

  it("refuses to overwrite an approved draft without forceRegenerate", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          starRating: 5,
          comment: "Great",
          reviewerDisplayName: "Sam",
          draftApproved: true,
          draftStatus: "approved",
          draftText: "Prior approved",
        }),
      }),
    });

    const res = await POST(
      new Request("http://localhost/api/reviews/x/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) }
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe("draft_approved");
    expect(generateMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it("rejects another organization's review id (isolation)", async () => {
    requireOrgUserMock.mockResolvedValue({ orgId: ORG_B, user: USER });
    findOneMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    const res = await POST(new Request("http://localhost/api/reviews/x/draft"), {
      params: Promise.resolve({ reviewId: REVIEW_ID }),
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.code).toBe("not_found");
    expect(generateMock).not.toHaveBeenCalled();
    expect(findOneMock).toHaveBeenCalledWith({
      _id: REVIEW_ID,
      orgId: ORG_B,
    });
  });

  it("returns 401 when there is no signed-in user / org session", async () => {
    requireOrgUserMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "unauthorized", message: "Authentication required." },
        { status: 401 }
      ),
    });

    const res = await POST(new Request("http://localhost/api/reviews/x/draft"), {
      params: Promise.resolve({ reviewId: REVIEW_ID }),
    });
    expect(res.status).toBe(401);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns 403 for cross-business review access", async () => {
    assertReviewAccessMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { success: false, code: "forbidden", message: "Denied" },
        { status: 403 }
      ),
    });

    const res = await POST(new Request("http://localhost/api/reviews/x/draft"), {
      params: Promise.resolve({ reviewId: REVIEW_ID }),
    });
    expect(res.status).toBe(403);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid review ids", async () => {
    const res = await POST(new Request("http://localhost/api/reviews/x/draft"), {
      params: Promise.resolve({ reviewId: "not-valid" }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("invalid_id");
    expect(assertReviewAccessMock).not.toHaveBeenCalled();
    expect(findOneMock).not.toHaveBeenCalled();
  });

  it("surfaces OpenAI configuration errors", async () => {
    isConfiguredMock.mockReturnValue(false);
    const res = await POST(new Request("http://localhost/api/reviews/x/draft"), {
      params: Promise.resolve({ reviewId: REVIEW_ID }),
    });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.code).toBe("not_configured");
  });
});

describe("PATCH /api/reviews/[reviewId]/draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    requireOrgUserMock.mockResolvedValue({ orgId: ORG_A, user: USER });
    assertReviewAccessMock.mockResolvedValue({ ok: true });
    updateOneMock.mockResolvedValue({ acknowledged: true });
    resolveBusinessMock.mockResolvedValue({
      ok: true,
      businessId: new mongoose.Types.ObjectId().toString(),
    });
    findOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: new mongoose.Types.ObjectId(),
          draftText: "Prior draft",
        }),
      }),
    });
  });

  it("persists draft edits without approving or calling AI", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/reviews/x/draft", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ draftText: "Edited locally" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      draft: "Edited locally",
      draftStatus: "edited",
      draftApproved: false,
    });
    expect(generateMock).not.toHaveBeenCalled();
    expect(updateOneMock).toHaveBeenCalledWith(
      { _id: REVIEW_ID, orgId: ORG_A },
      expect.objectContaining({
        $set: expect.objectContaining({
          draftText: "Edited locally",
          draftStatus: "edited",
          draftApproved: false,
        }),
      })
    );
  });

  it("approves a draft locally without publishing to Google", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/reviews/x/draft", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ draftText: "Ready", approve: true }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      draftStatus: "approved",
      draftApproved: true,
    });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("denies cross-business PATCH (isolation)", async () => {
    assertReviewAccessMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { success: false, code: "forbidden", message: "Denied" },
        { status: 403 }
      ),
    });
    const res = await PATCH(
      new Request("http://localhost/api/reviews/x/draft", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ draftText: "x" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) }
    );
    expect(res.status).toBe(403);
    expect(updateOneMock).not.toHaveBeenCalled();
  });
});
