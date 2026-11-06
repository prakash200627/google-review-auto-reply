import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  connectMock,
  paymentFindMock,
  paymentFindOneMock,
  paymentFindOneAndUpdateMock,
  businessFindByIdMock,
  assertOriginMock,
  auditLogMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  connectMock: vi.fn(),
  paymentFindMock: vi.fn(),
  paymentFindOneMock: vi.fn(),
  paymentFindOneAndUpdateMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  assertOriginMock: vi.fn(),
  auditLogMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/ManualPayment", () => ({
  ManualPayment: {
    find: paymentFindMock,
    findOne: paymentFindOneMock,
    findOneAndUpdate: paymentFindOneAndUpdateMock,
  },
  PAYMENT_STATUSES: [
    "expected",
    "received",
    "overdue",
    "waived",
    "not_recorded",
  ],
}));

vi.mock("@/models/Business", () => ({
  Business: { findById: businessFindByIdMock },
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: assertOriginMock,
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditLogMock,
}));

import { GET, POST } from "@/app/api/admin/payments/route";

const BIZ = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();

describe("GET/POST /api/admin/payments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    assertOriginMock.mockReturnValue({ ok: true });
  });

  it("rejects non-Super-Admin GET", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json({ success: false }, { status: 403 }),
    });
    const res = await GET(new Request("http://localhost/api/admin/payments"));
    expect(res.status).toBe(403);
  });

  it("lists empty ledger without inventing receipts", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
    paymentFindMock.mockReturnValue({
      sort: () => ({
        lean: async () => [],
      }),
    });
    const res = await GET(
      new Request("http://localhost/api/admin/payments?periodKey=2026-10")
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.payments).toEqual([]);
    expect(body.note).toMatch(/Manual ledger/);
  });

  it("upserts a manual payment row", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ,
          name: "Cafe",
          plan: { code: "starter", status: "active" },
        }),
      }),
    });
    paymentFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });
    paymentFindOneAndUpdateMock.mockReturnValue({
      lean: async () => ({
        _id: new mongoose.Types.ObjectId(),
        businessId: BIZ,
        periodKey: "2026-10",
      }),
    });

    const res = await POST(
      new Request("http://localhost/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          periodKey: "2026-10",
          status: "received",
          amountReceivedCents: 199900,
        }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/No payment provider/);
    expect(paymentFindOneAndUpdateMock).toHaveBeenCalled();
    expect(auditLogMock).toHaveBeenCalled();
  });

  it("rejects received status with zero amount", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ,
          plan: { code: "starter", status: "active" },
        }),
      }),
    });
    paymentFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    const res = await POST(
      new Request("http://localhost/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: BIZ,
          periodKey: "2026-10",
          status: "received",
          amountReceivedCents: 0,
        }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe("received_requires_amount");
    expect(paymentFindOneAndUpdateMock).not.toHaveBeenCalled();
  });
});
