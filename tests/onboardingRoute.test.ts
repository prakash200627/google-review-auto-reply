import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const { requireSuperAdminMock, completeMock, auditMock } = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  completeMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (
    value: { user: unknown } | { response: NextResponse }
  ): value is { user: unknown } => "user" in value,
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: () => ({ ok: true as const }),
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditMock,
}));

vi.mock("@/lib/business/onboarding", () => ({
  completeBusinessOnboarding: completeMock,
  OnboardingError: class OnboardingError extends Error {
    code: string;
    status: number;
    conflict?: unknown;
    constructor(
      message: string,
      opts: { code: string; status: number; conflict?: unknown }
    ) {
      super(message);
      this.code = opts.code;
      this.status = opts.status;
      this.conflict = opts.conflict;
    }
  },
}));

import { POST } from "@/app/api/admin/onboarding/route";

const USER = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId().toString();
const GROUP = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();

describe("POST /api/admin/onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditMock.mockResolvedValue(undefined);
  });

  it("denies Business Admin", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden" },
        { status: 403 }
      ),
    });
    const res = await POST(
      new Request("http://localhost/api/admin/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          name: "X",
          locationId: LOC,
          groupId: GROUP,
        }),
      })
    );
    expect(res.status).toBe(403);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("allows Super Admin and returns relationship", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });
    completeMock.mockResolvedValue({
      business: {
        id: BIZ,
        name: "Cafe",
        orgId: new mongoose.Types.ObjectId().toString(),
        groupId: GROUP,
        locationIds: [LOC],
        googleLocationNames: ["accounts/1/locations/1"],
      },
      group: { id: GROUP, name: "East" },
      location: {
        id: LOC,
        title: "Cafe",
        address: "",
        googleLocationName: "accounts/1/locations/1",
        businessInfoName: "locations/1",
        businessId: BIZ,
        verificationStatus: "unknown",
      },
      reassignedFrom: null,
    });

    const res = await POST(
      new Request("http://localhost/api/admin/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          name: "Cafe",
          locationId: LOC,
          groupId: GROUP,
          idempotencyKey: "idem-key-cccccccccccc",
        }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.business.id).toBe(BIZ);
    expect(body.group.id).toBe(GROUP);
    expect(body.location.verificationStatus).toBe("unknown");
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confirm: true,
        name: "Cafe",
        locationId: LOC,
        groupId: GROUP,
        idempotencyKey: "idem-key-cccccccccccc",
      })
    );
  });
});
