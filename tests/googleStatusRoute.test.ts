import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireOrgUserMock,
  getStatusMock,
  isConfiguredMock,
} = vi.hoisted(() => ({
  requireOrgUserMock: vi.fn(),
  getStatusMock: vi.fn(),
  isConfiguredMock: vi.fn(),
}));

vi.mock("@/lib/auth/googleRouteAuth", () => ({
  requireOrgAndUserAccess: requireOrgUserMock,
  isOrgUserResult: (value: { orgId: string } | { response: NextResponse }) =>
    "orgId" in value,
}));

vi.mock("@/lib/google/connectionStatus", () => ({
  getSafeGoogleConnectionStatus: getStatusMock,
  GOOGLE_STATUS_LOAD_ERROR_MESSAGE: "Could not load Google connection status.",
}));

vi.mock("@/lib/google/oauthConfig", () => ({
  isOAuthConfigured: isConfiguredMock,
}));

import { GET } from "@/app/api/auth/google/status/route";

const ORG = new mongoose.Types.ObjectId().toString();

describe("GET /api/auth/google/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isConfiguredMock.mockReturnValue(true);
  });

  it("rejects unauthenticated callers", async () => {
    requireOrgUserMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "unauthorized", message: "Authentication required." },
        { status: 401 }
      ),
    });

    const res = await GET();
    expect(res.status).toBe(401);
    expect(getStatusMock).not.toHaveBeenCalled();
  });

  it("rejects authenticated users without organization access", async () => {
    requireOrgUserMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden", message: "Not authorized." },
        { status: 403 }
      ),
    });

    const res = await GET();
    expect(res.status).toBe(403);
    expect(getStatusMock).not.toHaveBeenCalled();
  });

  it("returns minimal safe fields for authorized callers", async () => {
    requireOrgUserMock.mockResolvedValue({
      orgId: ORG,
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
    getStatusMock.mockResolvedValue({
      oauthConfigured: true,
      connection: {
        email: "gbp@example.com",
        status: "active",
        connectedAt: "2024-01-01T00:00:00.000Z",
        scopes: ["openid"],
        lastError: "",
      },
      statusError: null,
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(getStatusMock).toHaveBeenCalledWith(ORG);
    expect(body).toEqual({
      success: true,
      oauthConfigured: true,
      connection: {
        email: "gbp@example.com",
        status: "active",
        connectedAt: "2024-01-01T00:00:00.000Z",
        scopes: ["openid"],
        lastError: "",
      },
      statusError: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/token|ciphertext|refresh|accessToken/i);
  });
});
