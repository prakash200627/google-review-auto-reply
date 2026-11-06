import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  locationFindByIdMock,
  locationUpdateManyMock,
  businessFindByIdMock,
  clearReviewsMock,
  syncReviewsMock,
  withTxnMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  locationFindByIdMock: vi.fn(),
  locationUpdateManyMock: vi.fn(),
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
    updateMany: locationUpdateManyMock,
  },
}));

vi.mock("@/models/Business", () => ({
  Business: { findById: businessFindByIdMock },
}));

vi.mock("@/lib/business/stats", () => ({
  clearReviewBusinessIdsForLocations: clearReviewsMock,
  syncReviewBusinessIdsForLocations: syncReviewsMock,
}));

vi.mock("@/lib/mongo/transactions", () => ({
  withMongoTransaction: withTxnMock,
  isMongoDuplicateKeyError: (err: unknown) =>
    Boolean(
      err &&
        typeof err === "object" &&
        (err as { code?: number }).code === 11000
    ),
  MongoTransactionError: class MongoTransactionError extends Error {
    code: string;
    status: number;
    constructor(message: string, opts: { code: string; status: number }) {
      super(message);
      this.code = opts.code;
      this.status = opts.status;
    }
  },
}));

import {
  assignLocationToBusinessAtomic,
  getLocationAssignmentConflict,
  prepareLocationForAssignment,
  unassignLocationFromBusiness,
} from "@/lib/business/reassignLocation";
import { LocationAssignmentError } from "@/lib/business/assignLocations";

const LOC = new mongoose.Types.ObjectId();
const BIZ = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();
const ORG = new mongoose.Types.ObjectId();

describe("reassignLocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    clearReviewsMock.mockResolvedValue(undefined);
    syncReviewsMock.mockResolvedValue(undefined);
    locationUpdateManyMock.mockResolvedValue({});
    withTxnMock.mockImplementation(async (work: (s: unknown) => Promise<unknown>) =>
      work({})
    );
  });

  it("reports conflict when location is already assigned", async () => {
    locationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: LOC,
          businessId: BIZ,
          googleLocationName: "accounts/1/locations/1",
          title: "Cafe",
        }),
      }),
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          name: "Current Biz",
          groupId: null,
        }),
      }),
    });

    const conflict = await getLocationAssignmentConflict(String(LOC));
    expect(conflict?.currentBusinessName).toBe("Current Biz");
    expect(conflict?.currentBusinessId).toBe(String(BIZ));
  });

  it("blocks silent reassignment without confirmReassign", async () => {
    locationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: LOC,
          businessId: OTHER,
          googleLocationName: "accounts/1/locations/1",
          title: "Cafe",
        }),
      }),
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ name: "Other", groupId: null }),
      }),
    });

    await expect(
      prepareLocationForAssignment({
        locationId: String(LOC),
        targetBusinessId: String(BIZ),
        confirmReassign: false,
      })
    ).rejects.toMatchObject({ code: "location_already_assigned", status: 409 });
  });

  it("prepareLocationForAssignment validates but does not detach", async () => {
    locationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: LOC,
          businessId: OTHER,
          googleLocationName: "accounts/1/locations/1",
          title: "Cafe",
        }),
      }),
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ name: "Other", groupId: null }),
      }),
    });

    const prepared = await prepareLocationForAssignment({
      locationId: String(LOC),
      targetBusinessId: String(BIZ),
      confirmReassign: true,
    });

    expect(prepared.freed).toBe(false);
    expect(prepared.previousBusinessId).toBe(String(OTHER));
    expect(prepared.conflict?.currentBusinessId).toBe(String(OTHER));
    expect(withTxnMock).not.toHaveBeenCalled();
  });

  it("failed reassignment leaves prior relationship intact (txn abort)", async () => {
    withTxnMock.mockRejectedValue(new Error("txn aborted"));
    await expect(
      assignLocationToBusinessAtomic({
        locationId: String(LOC),
        targetBusinessId: String(BIZ),
        confirmReassign: true,
      })
    ).rejects.toThrow("txn aborted");
    // No ownership writes outside the transaction wrapper.
    expect(clearReviewsMock).not.toHaveBeenCalled();
  });

  it("unassigns explicitly inside a transaction", async () => {
    const locationDoc = {
      _id: LOC,
      businessId: OTHER,
      googleLocationName: "accounts/1/locations/1",
      save: vi.fn().mockResolvedValue(undefined),
    };
    const previousBiz = {
      locationIds: [LOC, new mongoose.Types.ObjectId()],
      googleLocationNames: ["accounts/1/locations/1", "other"],
      save: vi.fn().mockResolvedValue(undefined),
    };

    locationFindByIdMock.mockReturnValue({
      select: () => ({
        session: () => ({
          exec: async () => locationDoc,
        }),
      }),
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        session: () => ({
          exec: async () => previousBiz,
        }),
      }),
    });

    const result = await unassignLocationFromBusiness({
      locationId: String(LOC),
    });
    expect(result.previousBusinessId).toBe(String(OTHER));
    expect(locationDoc.businessId).toBeNull();
    expect(previousBiz.googleLocationNames).toEqual(["other"]);
    expect(clearReviewsMock).toHaveBeenCalled();
  });

  it("unassign is a no-op when already free", async () => {
    locationFindByIdMock.mockReturnValue({
      select: () => ({
        session: () => ({
          exec: async () => ({
            _id: LOC,
            businessId: null,
            googleLocationName: "accounts/1/locations/1",
            save: vi.fn(),
          }),
        }),
      }),
    });
    const result = await unassignLocationFromBusiness({
      locationId: String(LOC),
    });
    expect(result.previousBusinessId).toBeNull();
    expect(clearReviewsMock).not.toHaveBeenCalled();
  });

  it("atomic assign moves ownership without pre-detach", async () => {
    const locationDoc = {
      _id: LOC,
      orgId: ORG,
      businessId: OTHER as mongoose.Types.ObjectId | null,
      googleLocationName: "accounts/1/locations/1",
      save: vi.fn().mockResolvedValue(undefined),
    };
    const target = {
      _id: BIZ,
      orgId: ORG,
      locationIds: [] as mongoose.Types.ObjectId[],
      googleLocationNames: [] as string[],
      save: vi.fn().mockResolvedValue(undefined),
    };
    const previous = {
      locationIds: [LOC],
      googleLocationNames: ["accounts/1/locations/1"],
      save: vi.fn().mockResolvedValue(undefined),
    };

    locationFindByIdMock.mockImplementation(() => ({
      select: () => ({
        lean: async () => ({
          _id: LOC,
          businessId: OTHER,
          googleLocationName: "accounts/1/locations/1",
          title: "Cafe",
        }),
        session: () => ({
          exec: async () => locationDoc,
        }),
      }),
    }));

    businessFindByIdMock.mockImplementation((id: string) => {
      if (String(id) === String(OTHER)) {
        return {
          select: () => ({
            lean: async () => ({ name: "Other", groupId: null }),
            session: () => ({
              exec: async () => previous,
            }),
          }),
        };
      }
      return {
        select: () => ({
          session: () => ({
            exec: async () => target,
          }),
        }),
      };
    });

    const result = await assignLocationToBusinessAtomic({
      locationId: String(LOC),
      targetBusinessId: String(BIZ),
      confirmReassign: true,
    });

    expect(result.reassignedFrom?.currentBusinessId).toBe(String(OTHER));
    expect(String(locationDoc.businessId)).toBe(String(BIZ));
    expect(target.googleLocationNames).toEqual(["accounts/1/locations/1"]);
  });

  it("rejects invalid location ids", async () => {
    await expect(
      getLocationAssignmentConflict("bad")
    ).rejects.toBeInstanceOf(LocationAssignmentError);
  });
});
