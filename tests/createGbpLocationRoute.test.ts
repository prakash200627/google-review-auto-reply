import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  requireOrgMock,
  createMock,
  listAccountsMock,
  auditMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  requireOrgMock: vi.fn(),
  createMock: vi.fn(),
  listAccountsMock: vi.fn(),
  auditMock: vi.fn(),
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

vi.mock("@/lib/google/createLocation", () => ({
  createGbpLocationForOrg: createMock,
  listGoogleAccountsForOrg: listAccountsMock,
  CreateGbpLocationError: class CreateGbpLocationError extends Error {
    code: string;
    status: number;
    constructor(
      message: string,
      opts: { code?: string; status?: number } = {}
    ) {
      super(message);
      this.code = opts.code || "create_failed";
      this.status = opts.status || 400;
    }
  },
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditMock,
}));

import { GET as GET_ACCOUNTS } from "@/app/api/admin/google/accounts/route";
import { POST as POST_CREATE } from "@/app/api/admin/google/locations/route";

const ORG = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId().toString();

describe("POST /api/admin/google/locations authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgMock.mockResolvedValue({ orgId: ORG });
    auditMock.mockResolvedValue(undefined);
  });

  it("denies Business Admin without calling create", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden" },
        { status: 403 }
      ),
    });

    const res = await POST_CREATE(
      new Request("http://localhost/api/admin/google/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          googleAccountName: "accounts/1",
          requestId: "r1",
          title: "X",
          languageCode: "en",
        }),
      })
    );
    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("allows Super Admin and forwards selected account", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });
    createMock.mockResolvedValue({
      location: {
        id: LOC,
        title: "Cafe",
        address: "",
        storeCode: "",
        googleLocationName: "accounts/1/locations/9",
        googleAccountName: "accounts/1",
        businessInfoName: "locations/9",
        businessId: null,
        placeId: "",
        lastDiscoveryAt: null,
        lastReviewsSyncAt: null,
        lastReviewsSyncError: "",
      },
      googleAccountName: "accounts/1",
      googleLocationName: "accounts/1/locations/9",
      businessInfoName: "locations/9",
      verificationStatus: "unknown",
      verificationNote: "not queried",
      reusedIdempotentResult: false,
    });

    const res = await POST_CREATE(
      new Request("http://localhost/api/admin/google/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          googleAccountName: "accounts/1",
          requestId: "r-sa-1",
          title: "Cafe",
          languageCode: "en",
        }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.location.businessId).toBeNull();
    expect(body.verificationStatus).toBe("unknown");
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "accounts/1",
        requestId: "r-sa-1",
        title: "Cafe",
        languageCode: "en",
      })
    );
  });
});

describe("GET /api/admin/google/accounts authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgMock.mockResolvedValue({ orgId: ORG });
  });

  it("denies Business Admin", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden" },
        { status: 403 }
      ),
    });
    const res = await GET_ACCOUNTS();
    expect(res.status).toBe(403);
    expect(listAccountsMock).not.toHaveBeenCalled();
  });

  it("lists accounts for Super Admin", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });
    listAccountsMock.mockResolvedValue([
      { name: "accounts/1", accountName: "A", type: "PERSONAL" },
    ]);
    const res = await GET_ACCOUNTS();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.accounts).toHaveLength(1);
    expect(listAccountsMock).toHaveBeenCalledWith(ORG);
  });
});
