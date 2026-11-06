import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  businessFindMock,
  userFindMock,
  googleCountMock,
  googleFindMock,
  paymentFindMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  businessFindMock: vi.fn(),
  userFindMock: vi.fn(),
  googleCountMock: vi.fn(),
  googleFindMock: vi.fn(),
  paymentFindMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: { find: businessFindMock },
}));

vi.mock("@/models/User", () => ({
  User: { find: userFindMock },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: {
    countDocuments: googleCountMock,
    find: googleFindMock,
  },
}));

vi.mock("@/models/ManualPayment", () => ({
  ManualPayment: { find: paymentFindMock },
}));

import { getPlatformDashboardStats } from "@/lib/business/platformStats";

const ORG = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const OWNER = new mongoose.Types.ObjectId().toString();

describe("getPlatformDashboardStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("aggregates businesses and does not invent payment receipts", async () => {
    businessFindMock.mockReturnValue({
      sort: () => ({
        select: () => ({
          lean: async () => [
            {
              _id: BIZ,
              name: "Cafe One",
              active: true,
              orgId: ORG,
              ownerUserId: OWNER,
              plan: { code: "starter", status: "active" },
            },
          ],
        }),
      }),
    });
    userFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: OWNER, email: "owner@example.com", active: true },
        ],
      }),
    });
    googleCountMock.mockResolvedValue(1);
    googleFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ orgId: ORG }],
      }),
    });
    paymentFindMock.mockReturnValue({
      lean: async () => [],
    });

    const stats = await getPlatformDashboardStats();
    expect(stats.totalBusinesses).toBe(1);
    expect(stats.activeBusinesses).toBe(1);
    expect(stats.payments.rowCount).toBe(0);
    expect(stats.payments.configured).toBe(false);
    expect(stats.payments.receivedCents).toBe(0);
    expect(stats.payments.note).toMatch(/No manual payment rows/);
    expect(stats.businesses[0].googleConnected).toBe(true);
    expect(stats.monthlyExpectedCents).toBeGreaterThan(0);
  });

  it("catalog MRR remains active-business-only", async () => {
    const activeId = new mongoose.Types.ObjectId().toString();
    const suspendedId = new mongoose.Types.ObjectId().toString();
    businessFindMock.mockReturnValue({
      sort: () => ({
        select: () => ({
          lean: async () => [
            {
              _id: activeId,
              name: "24",
              active: true,
              status: "active",
              orgId: ORG,
              ownerUserId: null,
              plan: { code: "starter", status: "active", displayName: "Starter" },
            },
            {
              _id: suspendedId,
              name: "native south demo",
              active: false,
              status: "suspended",
              orgId: ORG,
              ownerUserId: null,
              plan: { code: "starter", status: "active", displayName: "Starter" },
            },
          ],
        }),
      }),
    });
    userFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    googleCountMock.mockResolvedValue(0);
    googleFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    paymentFindMock.mockReturnValue({ lean: async () => [] });

    const stats = await getPlatformDashboardStats();
    expect(stats.activeBusinesses).toBe(1);
    expect(stats.monthlyExpectedCents).toBe(199_900);
    const byName = Object.fromEntries(
      stats.businesses.map((b) => [b.name, b.listPriceCents])
    );
    expect(byName["24"]).toBe(199_900);
    expect(byName["native south demo"]).toBe(0);
  });
});

