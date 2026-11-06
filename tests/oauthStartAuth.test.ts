import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireAuthUserMock,
  ensureOrgMock,
  startAuthMock,
  isConfiguredMock,
} = vi.hoisted(() => ({
  requireAuthUserMock: vi.fn(),
  ensureOrgMock: vi.fn(),
  startAuthMock: vi.fn(),
  isConfiguredMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireAuthUser: requireAuthUserMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/org/session", () => ({
  ensureOrganizationSession: ensureOrgMock,
}));

vi.mock("@/lib/google/oauth", () => ({
  startAuthorization: startAuthMock,
}));

vi.mock("@/lib/google/oauthConfig", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/oauthConfig")>(
    "@/lib/google/oauthConfig"
  );
  return {
    ...actual,
    isOAuthConfigured: isConfiguredMock,
  };
});

import { POST } from "@/app/api/auth/google/start/route";

const ORG = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();

describe("POST /api/auth/google/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isConfiguredMock.mockReturnValue(true);
  });

  it("rejects unauthenticated callers before binding OAuth state", async () => {
    requireAuthUserMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "unauthorized" },
        { status: 401 }
      ),
    });

    const res = await POST(
      new Request("http://localhost/api/auth/google/start", { method: "POST" })
    );
    expect(res.status).toBe(401);
    expect(ensureOrgMock).not.toHaveBeenCalled();
    expect(startAuthMock).not.toHaveBeenCalled();
  });

  it("returns 503 when OAuth env is not configured", async () => {
    isConfiguredMock.mockReturnValue(false);
    requireAuthUserMock.mockResolvedValue({
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
    const res = await POST(
      new Request("http://localhost/api/auth/google/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnPath: "/gmb" }),
      })
    );
    expect(res.status).toBe(503);
    expect(startAuthMock).not.toHaveBeenCalled();
  });

  it("binds platform OAuth state to the Super Admin org session only", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    requireAuthUserMock.mockResolvedValue({
      user: {
        userId,
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
    ensureOrgMock.mockResolvedValue(ORG);
    startAuthMock.mockResolvedValue({
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const res = await POST(
      new Request("http://localhost/api/auth/google/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnPath: "/gmb" }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.connectionSource).toBe("platform");
    expect(startAuthMock).toHaveBeenCalledWith({
      orgId: ORG,
      initiatedByUserId: userId,
      connectionSource: "platform",
      businessId: null,
      returnPath: "/gmb",
    });
  });

  it("rejects client-supplied orgId on OAuth start", async () => {
    requireAuthUserMock.mockResolvedValue({
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });

    const res = await POST(
      new Request("http://localhost/api/auth/google/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnPath: "/gmb",
          orgId: new mongoose.Types.ObjectId().toString(),
        }),
      })
    );
    expect(res.status).toBe(403);
    expect(ensureOrgMock).not.toHaveBeenCalled();
    expect(startAuthMock).not.toHaveBeenCalled();
  });

  it("rejects Business Admin Google OAuth (TRONX login is email/password only)", async () => {
    requireAuthUserMock.mockResolvedValue({
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ],
      },
    });

    const res = await POST(
      new Request("http://localhost/api/auth/google/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnPath: "/gmb", businessId: BIZ }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("forbidden");
    expect(body.message).toMatch(/Super Admin/i);
    expect(startAuthMock).not.toHaveBeenCalled();
    expect(ensureOrgMock).not.toHaveBeenCalled();
  });
});
