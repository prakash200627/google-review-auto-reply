import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireOrgUserMock,
  assertReviewAccessMock,
  publishMock,
} = vi.hoisted(() => ({
  requireOrgUserMock: vi.fn(),
  assertReviewAccessMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock("@/lib/auth/googleRouteAuth", () => ({
  requireOrgAndUserAccess: requireOrgUserMock,
  assertUserCanAccessReview: assertReviewAccessMock,
  isOrgUserResult: (
    value: { orgId: string; user: unknown } | { response: NextResponse }
  ) => "orgId" in value && "user" in value,
}));

vi.mock("@/lib/google/publishReply", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/publishReply")>(
    "@/lib/google/publishReply"
  );
  return {
    ...actual,
    publishReviewReply: publishMock,
  };
});

import { POST } from "@/app/api/reviews/[reviewId]/reply/route";
import { PublishReplyError } from "@/lib/google/publishReply";

const ORG_A = new mongoose.Types.ObjectId().toString();
const REVIEW_ID = new mongoose.Types.ObjectId().toString();
const USER = {
  userId: new mongoose.Types.ObjectId().toString(),
  role: "superadmin" as const,
  email: "admin@example.com",
  businessIds: [] as string[],
};

describe("POST /api/reviews/[reviewId]/reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgUserMock.mockResolvedValue({ orgId: ORG_A, user: USER });
    assertReviewAccessMock.mockResolvedValue({ ok: true });
  });

  it("publishes after validation and returns Google-confirmed reply", async () => {
    publishMock.mockResolvedValue({
      replyComment: "Thanks for visiting!",
      replyUpdateTime: "2024-06-01T12:00:00.000Z",
      replyState: "APPROVED",
      replacedExisting: false,
    });

    const res = await POST(
      new Request("http://localhost/api/reviews/x/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: "Thanks for visiting!" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      published: true,
      reply: {
        comment: "Thanks for visiting!",
        state: "APPROVED",
      },
    });
    expect(publishMock).toHaveBeenCalledWith({
      orgId: ORG_A,
      reviewId: REVIEW_ID,
      comment: "Thanks for visiting!",
      confirmReplace: false,
    });
  });

  it("returns 401 without inventing success when session is missing", async () => {
    requireOrgUserMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "unauthorized", message: "Authentication required." },
        { status: 401 }
      ),
    });

    const res = await POST(
      new Request("http://localhost/api/reviews/x/reply", {
        method: "POST",
        body: JSON.stringify({ comment: "Thanks" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) }
    );
    expect(res.status).toBe(401);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("returns 403 for cross-business review access", async () => {
    assertReviewAccessMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { success: false, code: "forbidden", message: "Denied" },
        { status: 403 }
      ),
    });

    const res = await POST(
      new Request("http://localhost/api/reviews/x/reply", {
        method: "POST",
        body: JSON.stringify({ comment: "Thanks" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) }
    );
    expect(res.status).toBe(403);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("maps needs_replace_confirmation without publishing", async () => {
    publishMock.mockRejectedValue(
      new PublishReplyError("Confirm replacement", {
        code: "needs_replace_confirmation",
        status: 409,
        existingReply: "Old reply",
      })
    );

    const res = await POST(
      new Request("http://localhost/api/reviews/x/reply", {
        method: "POST",
        body: JSON.stringify({ comment: "New reply" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) }
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      code: "needs_replace_confirmation",
      existingReply: "Old reply",
    });
  });

  it("rejects invalid review ids", async () => {
    const res = await POST(
      new Request("http://localhost/api/reviews/x/reply", {
        method: "POST",
        body: JSON.stringify({ comment: "Thanks" }),
      }),
      { params: Promise.resolve({ reviewId: "bad-id" }) }
    );
    expect(res.status).toBe(400);
    expect(assertReviewAccessMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });
});
