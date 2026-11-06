import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  connectMock,
  businessFindByIdMock,
  upsertMock,
  setActiveMock,
  resetPasswordMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  connectMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  upsertMock: vi.fn(),
  setActiveMock: vi.fn(),
  resetPasswordMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: {
    findById: businessFindByIdMock,
  },
}));

vi.mock("@/models/User", () => ({
  User: {
    find: vi.fn(),
  },
}));

vi.mock("@/lib/business/owners", async () => {
  const actual = await vi.importActual<typeof import("@/lib/business/owners")>(
    "@/lib/business/owners"
  );
  return {
    ...actual,
    upsertBusinessOwner: upsertMock,
    setOwnerActive: setActiveMock,
    resetOwnerPassword: resetPasswordMock,
  };
});

import { POST } from "@/app/api/admin/owners/route";

const BIZ = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();

describe("POST /api/admin/owners", () => {
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

  it("rejects unauthenticated callers", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "unauthorized" },
        { status: 401 }
      ),
    });
    const res = await POST(
      new Request("http://localhost/api/admin/owners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset_password",
          userId: USER,
          newPassword: "password123",
        }),
      })
    );
    expect(res.status).toBe(401);
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it("rejects role escalation attempts", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/owners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          businessId: BIZ,
          email: "o@example.com",
          password: "password123",
          role: "superadmin",
        }),
      })
    );
    expect(res.status).toBe(403);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("links existing owners without claiming a password update", async () => {
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ name: "Cafe" }),
      }),
    });
    upsertMock.mockResolvedValue({
      userId: USER,
      created: false,
      linkedExisting: true,
      passwordSet: false,
    });

    const res = await POST(
      new Request("http://localhost/api/admin/owners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "assign",
          businessId: BIZ,
          email: "owner@example.com",
          password: "ignored",
        }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.owner.passwordSet).toBe(false);
    expect(body.message).toMatch(/password was not changed/i);
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|hashed:/i);
  });

  it("supports explicit password reset without returning secrets", async () => {
    resetPasswordMock.mockResolvedValue(undefined);

    const res = await POST(
      new Request("http://localhost/api/admin/owners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset_password",
          userId: USER,
          newPassword: "password123",
        }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(resetPasswordMock).toHaveBeenCalledWith({
      userId: USER,
      newPassword: "password123",
    });
    expect(body.message).toMatch(/out-of-band/i);
    expect(body.message).toMatch(/does not send email/i);
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("passwordHash");
  });
});
