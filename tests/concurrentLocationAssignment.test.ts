import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  locationFindByIdMock,
  businessFindByIdMock,
  clearReviewsMock,
  syncReviewsMock,
  withTxnMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  locationFindByIdMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  clearReviewsMock: vi.fn(),
  syncReviewsMock: vi.fn(),
  withTxnMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Location", () => ({
  Location: {
    findById: locationFindByIdMock,
    updateMany: vi.fn(),
  },
}));

vi.mock("@/models/Business", () => ({
  Business: { findById: businessFindByIdMock },
}));

vi.mock("@/lib/business/stats", () => ({
  clearReviewBusinessIdsForLocations: clearReviewsMock,
  syncReviewBusinessIdsForLocations: syncReviewsMock,
}));

vi.mock("@/lib/mongo/transactions", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/mongo/transactions")
  >("@/lib/mongo/transactions");
  return {
    ...actual,
    withMongoTransaction: withTxnMock,
  };
});

import { assignLocationToBusinessAtomic } from "@/lib/business/reassignLocation";

const LOC = new mongoose.Types.ObjectId();
const BIZ_A = new mongoose.Types.ObjectId();
const BIZ_B = new mongoose.Types.ObjectId();
const ORG = new mongoose.Types.ObjectId();

describe("concurrent location assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    clearReviewsMock.mockResolvedValue(undefined);
    syncReviewsMock.mockResolvedValue(undefined);
  });

  it("duplicate-key from unique index surfaces as conflict (no conflicting ownership)", async () => {
    withTxnMock.mockImplementation(async (work: (s: unknown) => Promise<unknown>) => {
      const locationDoc = {
        _id: LOC,
        orgId: ORG,
        businessId: null as mongoose.Types.ObjectId | null,
        googleLocationName: "accounts/1/locations/1",
        save: vi.fn().mockRejectedValue({ code: 11000, message: "E11000" }),
      };
      const target = {
        _id: BIZ_A,
        orgId: ORG,
        locationIds: [] as mongoose.Types.ObjectId[],
        googleLocationNames: [] as string[],
        save: vi.fn(),
      };

      locationFindByIdMock.mockReturnValue({
        select: () => ({
          lean: async () => ({
            _id: LOC,
            businessId: null,
            googleLocationName: "accounts/1/locations/1",
            title: "Cafe",
          }),
          session: () => ({
            exec: async () => locationDoc,
          }),
        }),
      });
      businessFindByIdMock.mockReturnValue({
        select: () => ({
          session: () => ({
            exec: async () => target,
          }),
        }),
      });

      return work({});
    });

    await expect(
      assignLocationToBusinessAtomic({
        locationId: String(LOC),
        targetBusinessId: String(BIZ_A),
      })
    ).rejects.toMatchObject({
      code: "location_business_conflict",
      status: 409,
    });
  });

  it("second concurrent assign fails closed when transaction cannot run", async () => {
    const { MongoTransactionError } = await import(
      "@/lib/mongo/transactions"
    );
    withTxnMock.mockRejectedValue(
      new MongoTransactionError(
        "This MongoDB deployment does not support multi-document transactions",
        { code: "transactions_required", status: 503 }
      )
    );

    await expect(
      assignLocationToBusinessAtomic({
        locationId: String(LOC),
        targetBusinessId: String(BIZ_B),
        confirmReassign: true,
      })
    ).rejects.toMatchObject({
      code: "transactions_required",
      status: 503,
    });
  });
});
