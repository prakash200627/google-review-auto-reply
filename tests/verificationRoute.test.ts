import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  requireOrgMock,
  getStoredMock,
  refreshMock,
  fetchOptionsMock,
  startMock,
  completeMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  requireOrgMock: vi.fn(),
  getStoredMock: vi.fn(),
  refreshMock: vi.fn(),
  fetchOptionsMock: vi.fn(),
  startMock: vi.fn(),
  completeMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (
    value: { user: unknown } | { response: NextResponse }
  ): value is { user: unknown } => "user" in value,
}));

vi.mock("@/lib/org/requireOrg", () => ({
  requireOrganizationId: requireOrgMock,
  isOrgResult: (
    value: { orgId: string } | { response: NextResponse }
  ): value is { orgId: string } => "orgId" in value,
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: () => ({ ok: true as const }),
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/google/verification", () => ({
  getStoredVerificationSnapshot: getStoredMock,
  refreshLocationVerificationStatus: refreshMock,
  fetchOptionsForLocation: fetchOptionsMock,
  startVerificationForLocation: startMock,
  completeVerificationForLocation: completeMock,
  isVerificationMethod: (value: unknown) =>
    typeof value === "string" &&
    ["ADDRESS", "EMAIL", "PHONE_CALL", "SMS", "AUTO", "VETTED_PARTNER"].includes(
      value
    ),
  VerificationServiceError: class VerificationServiceError extends Error {
    code: string;
    status: number;
    constructor(
      message: string,
      opts: { code?: string; status?: number } = {}
    ) {
      super(message);
      this.code = opts.code || "verification_error";
      this.status = opts.status || 400;
    }
  },
}));

import {
  GET as GET_STATUS,
  POST as POST_REFRESH,
} from "@/app/api/admin/google/locations/[locationId]/verification/route";
import { POST as POST_OPTIONS } from "@/app/api/admin/google/locations/[locationId]/verification/options/route";
import { POST as POST_START } from "@/app/api/admin/google/locations/[locationId]/verification/start/route";
import { POST as POST_COMPLETE } from "@/app/api/admin/google/locations/[locationId]/verification/complete/route";

const ORG = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();
const ctx = { params: Promise.resolve({ locationId: LOC }) };

describe("verification routes authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgMock.mockResolvedValue({ orgId: ORG });
  });

  it("denies Business Admin on refresh/options/start/complete", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden" },
        { status: 403 }
      ),
    });

    const getSnapshot = await GET_STATUS(
      new Request("http://localhost/x"),
      ctx
    );
    expect(getSnapshot.status).toBe(403);
    expect(getStoredMock).not.toHaveBeenCalled();

    const refresh = await POST_REFRESH(
      new Request("http://localhost/x", { method: "POST" }),
      ctx
    );
    const options = await POST_OPTIONS(
      new Request("http://localhost/x", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );
    const start = await POST_START(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ confirmStart: true, method: "AUTO" }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );
    const complete = await POST_COMPLETE(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ confirmComplete: true, pin: "123456" }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(refresh.status).toBe(403);
    expect(options.status).toBe(403);
    expect(start.status).toBe(403);
    expect(complete.status).toBe(403);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(fetchOptionsMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("allows Super Admin refresh and options", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });
    refreshMock.mockResolvedValue({
      locationId: LOC,
      verificationStatus: "unverified",
      publicVisibilityClaim: false,
    });
    fetchOptionsMock.mockResolvedValue({
      options: [{ verificationMethod: "SMS", phoneNumber: "+1" }],
      languageCode: "en",
      locationName: "locations/1",
    });

    const refresh = await POST_REFRESH(
      new Request("http://localhost/x", { method: "POST" }),
      ctx
    );
    const options = await POST_OPTIONS(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ languageCode: "en" }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(refresh.status).toBe(200);
    expect(options.status).toBe(200);
    expect(refreshMock).toHaveBeenCalledWith(ORG, LOC);
    expect(fetchOptionsMock).toHaveBeenCalledWith(ORG, LOC, "en");
  });

  it("requires confirmStart before calling Google verify", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });

    const res = await POST_START(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ method: "AUTO" }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("confirmation_required");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("starts verification for Super Admin after confirm", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });
    startMock.mockResolvedValue({
      verification: {
        name: "locations/1/verifications/2",
        method: "AUTO",
        state: "COMPLETED",
      },
      snapshot: {
        locationId: LOC,
        verificationStatus: "verified",
        publicVisibilityClaim: false,
      },
    });

    const res = await POST_START(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({
          confirmStart: true,
          method: "AUTO",
          languageCode: "en",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(startMock).toHaveBeenCalledWith(
      ORG,
      LOC,
      expect.objectContaining({ method: "AUTO", languageCode: "en" })
    );
  });

  it("loads stored snapshot for Super Admin GET", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });
    getStoredMock.mockResolvedValue({
      locationId: LOC,
      verificationStatus: "unknown",
    });
    const res = await GET_STATUS(
      new Request("http://localhost/x"),
      ctx
    );
    expect(res.status).toBe(200);
    expect(getStoredMock).toHaveBeenCalledWith(ORG, LOC);
  });
});
