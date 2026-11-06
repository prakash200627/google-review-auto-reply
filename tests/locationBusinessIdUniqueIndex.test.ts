import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  aggregateMock,
  indexesMock,
  createIndexMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  aggregateMock: vi.fn(),
  indexesMock: vi.fn(),
  createIndexMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Location", () => ({
  Location: {
    aggregate: aggregateMock,
    collection: {
      indexes: indexesMock,
      createIndex: createIndexMock,
    },
  },
}));

import {
  ensureLocationBusinessIdUniqueIndex,
  findDuplicateLocationBusinessIds,
  getLocationBusinessIdUniqueIndexStatus,
  LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME,
} from "@/lib/location/businessIdUniqueIndex";

describe("location businessId unique index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("reports duplicate businessId groups without mutating data", async () => {
    aggregateMock.mockResolvedValue([
      {
        _id: "biz1",
        locationIds: ["loc1", "loc2"],
        count: 2,
      },
    ]);

    const duplicates = await findDuplicateLocationBusinessIds();
    expect(duplicates).toEqual([
      {
        businessId: "biz1",
        locationIds: ["loc1", "loc2"],
        count: 2,
      },
    ]);
    expect(createIndexMock).not.toHaveBeenCalled();
  });

  it("does not claim constraintActive when duplicates exist", async () => {
    aggregateMock.mockResolvedValue([
      { _id: "biz1", locationIds: ["a", "b"], count: 2 },
    ]);
    indexesMock.mockResolvedValue([
      {
        name: LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME,
        unique: true,
        key: { businessId: 1 },
        partialFilterExpression: { businessId: { $type: "objectId" } },
      },
    ]);

    const status = await getLocationBusinessIdUniqueIndexStatus();
    expect(status.constraintActive).toBe(false);
    expect(status.duplicates).toHaveLength(1);
    expect(status.message).toMatch(/Resolve duplicates/i);
  });

  it("refuses index create when duplicates exist (no silent data loss)", async () => {
    aggregateMock.mockResolvedValue([
      { _id: "biz1", locationIds: ["a", "b"], count: 2 },
    ]);
    indexesMock.mockResolvedValue([]);

    await expect(ensureLocationBusinessIdUniqueIndex()).rejects.toThrow(
      /REFUSED_INDEX_CREATE/
    );
    expect(createIndexMock).not.toHaveBeenCalled();
  });

  it("creates index and reports active only when verified", async () => {
    aggregateMock.mockResolvedValue([]);
    indexesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          name: LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME,
          unique: true,
          key: { businessId: 1 },
          partialFilterExpression: {
            businessId: { $exists: true, $type: "objectId" },
          },
        },
      ]);
    // after create: getLocationBusinessIdUniqueIndexStatus calls indexes + aggregate again
    aggregateMock.mockResolvedValue([]);
    createIndexMock.mockResolvedValue(LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME);

    // ensure calls get status (before), createIndex, get status (after)
    indexesMock.mockResolvedValue([
      {
        name: LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME,
        unique: true,
        key: { businessId: 1 },
        partialFilterExpression: {
          businessId: { $exists: true, $type: "objectId" },
        },
      },
    ]);

    const after = await ensureLocationBusinessIdUniqueIndex();
    expect(createIndexMock).toHaveBeenCalledWith(
      { businessId: 1 },
      expect.objectContaining({
        unique: true,
        name: LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME,
      })
    );
    expect(after.constraintActive).toBe(true);
  });

  it("surfaces createIndex failures instead of claiming success", async () => {
    aggregateMock.mockResolvedValue([]);
    indexesMock.mockResolvedValue([]);
    createIndexMock.mockRejectedValue({
      code: 11000,
      message: "E11000 duplicate key error",
    });

    await expect(ensureLocationBusinessIdUniqueIndex()).rejects.toThrow(
      /INDEX_CREATE_FAILED/
    );
  });

  it("treats duplicate-key on assignment as a conflict (index rejection)", async () => {
    // Behavioral contract used by onboarding/reassign when index is active.
    const { isMongoDuplicateKeyError } = await import(
      "@/lib/mongo/transactions"
    );
    expect(isMongoDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isMongoDuplicateKeyError(new Error("E11000 duplicate key"))).toBe(
      true
    );
    expect(isMongoDuplicateKeyError(new Error("other"))).toBe(false);
  });
});
