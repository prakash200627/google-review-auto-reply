/**
 * Route-level security hardening: inactive access, forged ids, owner ops,
 * and failed publish must not report success.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireOrgUserMock,
  assertReviewAccessMock,
  requireSuperAdminMock,
  requireAuthMock,
  assertBusinessAccessMock,
  publishMock,
  auditMock,
} = vi.hoisted(() => ({
  requireOrgUserMock: vi.fn(),
  assertReviewAccessMock: vi.fn(),
  requireSuperAdminMock: vi.fn(),
  requireAuthMock: vi.fn(),
  assertBusinessAccessMock: vi.fn(),
  publishMock: vi.fn(),
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
    requireSuperAdmin: requireSuperAdminMock,
    requireAuthUser: requireAuthMock,
    assertBusinessAccess: assertBusinessAccessMock,
    isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
      "user" in value,
  };
});

vi.mock("@/lib/google/publishReply", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/publishReply")>(
    "@/lib/google/publishReply"
  );
  return { ...actual, publishReviewReply: publishMock };
});

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditMock,
}));

import { POST as publishPost } from "@/app/api/reviews/[reviewId]/reply/route";
import { POST as ownersPost } from "@/app/api/admin/owners/route";
import { PATCH as settingsPatch } from "@/app/api/business/[businessId]/settings/route";
import { PublishReplyError } from "@/lib/google/publishReply";

const ORG = new mongoose.Types.ObjectId().toString();
const REVIEW = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();

describe("security hardening routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects forged review ids before publish", async () => {
    requireOrgUserMock.mockResolvedValue({
      orgId: ORG,
      user: {
        userId: USER,
        role: "business_owner",
        email: "o@example.com",
        businessIds: [BIZ],
      },
    });

    const res = await publishPost(
      new Request("http://localhost:3000/api/reviews/not-an-id/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ comment: "Thanks!" }),
      }),
      { params: Promise.resolve({ reviewId: "not-an-id" }) }
    );
    expect(res.status).toBe(400);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("does not mark failed Google publish as successful", async () => {
    requireOrgUserMock.mockResolvedValue({
      orgId: ORG,
      user: {
        userId: USER,
        role: "business_owner",
        email: "o@example.com",
        businessIds: [BIZ],
      },
    });
    assertReviewAccessMock.mockResolvedValue({ ok: true });
    publishMock.mockRejectedValue(
      new PublishReplyError("Google rejected the reply", {
        code: "google_error",
        status: 502,
      })
    );

    const res = await publishPost(
      new Request(`http://localhost:3000/api/reviews/${REVIEW}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ comment: "Thanks!" }),
      }),
      { params: Promise.resolve({ reviewId: REVIEW }) }
    );
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.published).toBeUndefined();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review.publish",
        success: false,
        code: "google_error",
      })
    );
  });

  it("blocks unauthorized owner password reset", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden" },
        { status: 403 }
      ),
    });

    const res = await ownersPost(
      new Request("http://localhost:3000/api/admin/owners", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          action: "reset_password",
          userId: USER,
          newPassword: "password123",
        }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("blocks owners from changing reply mode via settings", async () => {
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "business_owner",
        email: "o@example.com",
        businessIds: [BIZ],
      },
    });
    assertBusinessAccessMock.mockResolvedValue({
      ok: true,
      business: {
        _id: new mongoose.Types.ObjectId(BIZ),
        active: true,
      },
    });

    const res = await settingsPatch(
      new Request(`http://localhost:3000/api/business/${BIZ}/settings`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ replyMode: "auto" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(403);
  });

  it("rejects inactive business access for owners on settings", async () => {
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "business_owner",
        email: "o@example.com",
        businessIds: [BIZ],
      },
    });
    assertBusinessAccessMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { success: false, code: "business_inactive" },
        { status: 403 }
      ),
    });

    const res = await settingsPatch(
      new Request(`http://localhost:3000/api/business/${BIZ}/settings`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ brandVoice: "friendly" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(403);
  });
});
