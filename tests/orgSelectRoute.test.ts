import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  connectMock,
  findByIdMock,
  applyCookieMock,
  auditMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  connectMock: vi.fn(),
  findByIdMock: vi.fn(),
  applyCookieMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Organization", () => ({
  Organization: {
    findById: findByIdMock,
  },
}));

vi.mock("@/lib/org/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/org/session")>(
    "@/lib/org/session"
  );
  return {
    ...actual,
    applySelectedOrganizationCookie: applyCookieMock,
  };
});

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditMock,
}));

import { POST } from "@/app/api/admin/organizations/select/route";

const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();

describe("POST /api/admin/organizations/select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
  });

  it("rejects business owners (unauthorized switching)", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden" },
        { status: 403 }
      ),
    });

    const res = await POST(
      new Request("http://localhost:3000/api/admin/organizations/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ orgId: ORG_A }),
      })
    );
    expect(res.status).toBe(403);
    expect(applyCookieMock).not.toHaveBeenCalled();
  });

  it("rejects forged / invalid organization ids", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/admin/organizations/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ orgId: "not-a-real-id" }),
      })
    );
    expect(res.status).toBe(400);
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(applyCookieMock).not.toHaveBeenCalled();
  });

  it("rejects unknown organization ids (stale / cross-env)", async () => {
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    const res = await POST(
      new Request("http://localhost:3000/api/admin/organizations/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ orgId: ORG_B }),
      })
    );
    expect(res.status).toBe(404);
    expect(applyCookieMock).not.toHaveBeenCalled();
  });

  it("sets a signed cookie for an authorized Super Admin switch", async () => {
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: ORG_A, name: "Workspace A" }),
      }),
    });

    const res = await POST(
      new Request("http://localhost:3000/api/admin/organizations/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ orgId: ORG_A }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.orgId).toBe(ORG_A);
    expect(applyCookieMock).toHaveBeenCalledWith(expect.any(NextResponse), ORG_A);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.select",
        success: true,
        target: { orgId: ORG_A },
      })
    );
  });

  it("rejects unauthorized Origin on select", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/admin/organizations/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ orgId: ORG_A }),
      })
    );
    expect(res.status).toBe(403);
    expect(requireSuperAdminMock).not.toHaveBeenCalled();
  });
});
