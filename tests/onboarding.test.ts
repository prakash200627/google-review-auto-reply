import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  locationFindByIdMock,
  orgFindByIdMock,
  groupFindByIdMock,
  connectionFindOneMock,
  businessCreateMock,
  businessFindByIdMock,
  assertMovableMock,
  setGroupMock,
  refreshOwnersMock,
  syncReviewsMock,
  clearReviewsMock,
  withTxnMock,
  claimMock,
  markSucceededMock,
  markFailedMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  locationFindByIdMock: vi.fn(),
  orgFindByIdMock: vi.fn(),
  groupFindByIdMock: vi.fn(),
  connectionFindOneMock: vi.fn(),
  businessCreateMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  assertMovableMock: vi.fn(),
  setGroupMock: vi.fn(),
  refreshOwnersMock: vi.fn(),
  syncReviewsMock: vi.fn(),
  clearReviewsMock: vi.fn(),
  withTxnMock: vi.fn(),
  claimMock: vi.fn(),
  markSucceededMock: vi.fn(),
  markFailedMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Location", () => ({
  Location: {
    findById: locationFindByIdMock,
  },
}));

vi.mock("@/models/Organization", () => ({
  Organization: { findById: orgFindByIdMock },
}));

vi.mock("@/models/BusinessGroup", () => ({
  BusinessGroup: { findById: groupFindByIdMock },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: { findOne: connectionFindOneMock },
}));

vi.mock("@/models/Business", () => ({
  Business: {
    create: businessCreateMock,
    findById: businessFindByIdMock,
  },
  BRAND_VOICES: ["friendly", "professional"],
  REPLY_MODES: ["manual", "auto"],
}));

vi.mock("@/lib/business/reassignLocation", () => ({
  assertLocationMovable: assertMovableMock,
}));

vi.mock("@/lib/groups/membership", () => ({
  setBusinessGroup: setGroupMock,
  refreshOwnersForBusinessGroupChange: refreshOwnersMock,
  GroupMembershipError: class GroupMembershipError extends Error {
    code: string;
    status: number;
    constructor(
      message: string,
      opts: { code?: string; status?: number } = {}
    ) {
      super(message);
      this.code = opts.code || "group_error";
      this.status = opts.status || 400;
    }
  },
}));

vi.mock("@/lib/business/stats", () => ({
  syncReviewBusinessIdsForLocations: syncReviewsMock,
  clearReviewBusinessIdsForLocations: clearReviewsMock,
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

vi.mock("@/lib/idempotency/onboardingClaim", () => ({
  claimOnboardingIdempotency: claimMock,
  markOnboardingIdempotencySucceeded: markSucceededMock,
  markOnboardingIdempotencyFailed: markFailedMock,
  isOnboardingIdempotencyError: (err: unknown) =>
    Boolean(
      err &&
        typeof err === "object" &&
        "code" in err &&
        String((err as { code: string }).code).startsWith("idempotency_")
    ),
}));

vi.mock("@/lib/entitlements/plans", () => ({
  isPlanCode: () => true,
  defaultPlanFields: () => ({ code: "starter" }),
}));

import {
  completeBusinessOnboarding,
  OnboardingError,
} from "@/lib/business/onboarding";
import { LocationAssignmentError } from "@/lib/business/assignLocations";

const ORG = new mongoose.Types.ObjectId();
const LOC = new mongoose.Types.ObjectId();
const GROUP = new mongoose.Types.ObjectId();
const BIZ = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();
const IDEM = "idem-key-aaaaaaaaaaaa";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    confirm: true as const,
    name: "Cafe Biz",
    locationId: String(LOC),
    groupId: String(GROUP),
    idempotencyKey: IDEM,
    ...overrides,
  };
}

describe("completeBusinessOnboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    assertMovableMock.mockResolvedValue({
      conflict: null,
      requiresReassign: false,
    });
    setGroupMock.mockResolvedValue({
      previousGroupId: null,
      groupId: String(GROUP),
    });
    refreshOwnersMock.mockResolvedValue(undefined);
    syncReviewsMock.mockResolvedValue(undefined);
    clearReviewsMock.mockResolvedValue(undefined);
    withTxnMock.mockImplementation(async (work: (s: unknown) => Promise<unknown>) =>
      work({})
    );
    claimMock.mockResolvedValue({
      kind: "execute",
      recordId: new mongoose.Types.ObjectId().toString(),
    });
    markSucceededMock.mockResolvedValue(undefined);
    markFailedMock.mockResolvedValue(undefined);
    orgFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: ORG }) }),
    });
    groupFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: GROUP,
          name: "East",
          orgId: ORG,
          active: true,
        }),
      }),
    });
    connectionFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ status: "active" }),
      }),
    });
    locationFindByIdMock.mockImplementation(() => {
      const locDoc = {
        _id: LOC,
        orgId: ORG,
        businessId: null as mongoose.Types.ObjectId | null,
        googleLocationName: "accounts/1/locations/1",
        businessInfoName: "locations/1",
        title: "Cafe",
        address: "1 Main",
        verificationStatus: "unknown",
        save: vi.fn().mockResolvedValue(undefined),
      };
      return {
        select: () => ({
          lean: async () => ({
            _id: LOC,
            orgId: ORG,
            businessId: null,
            googleLocationName: "accounts/1/locations/1",
            businessInfoName: "locations/1",
            title: "Cafe",
            address: "1 Main",
            verificationStatus: "unknown",
          }),
        }),
        session: () => ({
          exec: async () => locDoc,
        }),
      };
    });
    businessCreateMock.mockResolvedValue([
      {
        _id: BIZ,
        name: "Cafe Biz",
      },
    ]);
  });

  it("requires confirm=true", async () => {
    await expect(
      completeBusinessOnboarding({
        confirm: false,
        name: "Cafe",
        locationId: String(LOC),
        groupId: String(GROUP),
        idempotencyKey: IDEM,
      })
    ).rejects.toMatchObject({ code: "confirmation_required" });
    expect(businessCreateMock).not.toHaveBeenCalled();
  });

  it("requires idempotencyKey", async () => {
    await expect(
      completeBusinessOnboarding(baseInput({ idempotencyKey: "short" }))
    ).rejects.toMatchObject({ code: "missing_idempotency_key" });
  });

  it("creates business, assigns location, sets group explicitly", async () => {
    const result = await completeBusinessOnboarding(baseInput());

    expect(result.business.id).toBe(String(BIZ));
    expect(result.group?.id).toBe(String(GROUP));
    expect(result.location.id).toBe(String(LOC));
    expect(result.reusedIdempotentResult).toBe(false);
    expect(businessCreateMock).toHaveBeenCalled();
    expect(markSucceededMock).toHaveBeenCalled();
    expect(claimMock).toHaveBeenCalled();
  });

  it("replays same key + same payload without creating another business", async () => {
    const prior = {
      business: {
        id: String(BIZ),
        name: "Cafe Biz",
        orgId: String(ORG),
        groupId: String(GROUP),
        locationIds: [String(LOC)],
        googleLocationNames: ["accounts/1/locations/1"],
      },
      group: { id: String(GROUP), name: "East" },
      location: {
        id: String(LOC),
        title: "Cafe",
        address: "1 Main",
        googleLocationName: "accounts/1/locations/1",
        businessInfoName: "locations/1",
        businessId: String(BIZ),
        verificationStatus: "unknown",
      },
      reassignedFrom: null,
    };
    claimMock.mockResolvedValue({
      kind: "replay",
      result: prior,
      reusedIdempotentResult: true,
    });

    const result = await completeBusinessOnboarding(baseInput());
    expect(result.business.id).toBe(String(BIZ));
    expect(result.reusedIdempotentResult).toBe(true);
    expect(businessCreateMock).not.toHaveBeenCalled();
    expect(withTxnMock).not.toHaveBeenCalled();
  });

  it("conflicts when same key is reused with a different payload", async () => {
    const err = Object.assign(
      new Error("payload conflict"),
      { code: "idempotency_payload_conflict", status: 409 }
    );
    claimMock.mockRejectedValue(err);

    await expect(
      completeBusinessOnboarding(baseInput({ name: "Other Name" }))
    ).rejects.toMatchObject({
      code: "idempotency_payload_conflict",
      status: 409,
    });
    expect(businessCreateMock).not.toHaveBeenCalled();
  });

  it("does not create when location is already assigned without confirmReassign", async () => {
    assertMovableMock.mockRejectedValue(
      new LocationAssignmentError(
        'This location is already assigned to "Other". Confirm an explicit reassignment to move it.',
        { code: "location_already_assigned", status: 409 }
      )
    );
    locationFindByIdMock
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => ({
            _id: LOC,
            orgId: ORG,
            businessId: OTHER,
            googleLocationName: "accounts/1/locations/1",
            businessInfoName: "locations/1",
            title: "Cafe",
            address: "1 Main",
            verificationStatus: "pending",
          }),
        }),
      })
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => ({ businessId: OTHER }),
        }),
      });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ name: "Other", groupId: null }),
      }),
    });

    await expect(
      completeBusinessOnboarding(
        baseInput({ confirmReassign: false })
      )
    ).rejects.toBeInstanceOf(OnboardingError);

    expect(businessCreateMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("records reassignment when confirmReassign moves a prior business", async () => {
    assertMovableMock.mockResolvedValue({
      requiresReassign: true,
      conflict: {
        locationId: String(LOC),
        googleLocationName: "accounts/1/locations/1",
        title: "Cafe",
        currentBusinessId: String(OTHER),
        currentBusinessName: "Other",
        currentGroupId: null,
      },
    });
    const previousBiz = {
      locationIds: [LOC],
      googleLocationNames: ["accounts/1/locations/1"],
      save: vi.fn().mockResolvedValue(undefined),
    };
    businessFindByIdMock.mockReturnValue({
      session: () => ({
        exec: async () => previousBiz,
      }),
    });

    const result = await completeBusinessOnboarding(
      baseInput({ confirmReassign: true })
    );

    expect(result.reassignedFrom).toEqual({
      businessId: String(OTHER),
      businessName: "Other",
    });
  });

  it("rejects org mismatch between group and location", async () => {
    groupFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: GROUP,
          name: "East",
          orgId: new mongoose.Types.ObjectId(),
          active: true,
        }),
      }),
    });

    await expect(completeBusinessOnboarding(baseInput())).rejects.toMatchObject({
      code: "org_mismatch",
    });
    expect(businessCreateMock).not.toHaveBeenCalled();
  });

  it("failed onboarding leaves no partial business when transaction throws", async () => {
    withTxnMock.mockRejectedValue(new Error("txn aborted"));
    await expect(completeBusinessOnboarding(baseInput())).rejects.toThrow(
      "txn aborted"
    );
    expect(markFailedMock).toHaveBeenCalled();
    expect(refreshOwnersMock).not.toHaveBeenCalled();
  });
});
