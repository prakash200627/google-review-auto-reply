/**
 * POST /api/admin/businesses — creation route coverage (mocked DB / helpers).
 * Does not touch live Mongo or Google.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  connectMock,
  withTxnMock,
  assertMovableMock,
  resolveLocationMock,
  loadAssignableMock,
  assertAssignableMock,
  validateLocationInputMock,
  upsertOwnerMock,
  setGroupMock,
  refreshOwnersMock,
  clearReviewsMock,
  syncReviewsMock,
  businessCreateMock,
  businessFindByIdMock,
  locationFindByIdMock,
  orgFindByIdMock,
  readOrgIdMock,
  auditMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  connectMock: vi.fn(),
  withTxnMock: vi.fn(),
  assertMovableMock: vi.fn(),
  resolveLocationMock: vi.fn(),
  loadAssignableMock: vi.fn(),
  assertAssignableMock: vi.fn(),
  validateLocationInputMock: vi.fn(),
  upsertOwnerMock: vi.fn(),
  setGroupMock: vi.fn(),
  refreshOwnersMock: vi.fn(),
  clearReviewsMock: vi.fn(),
  syncReviewsMock: vi.fn(),
  businessCreateMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  locationFindByIdMock: vi.fn(),
  orgFindByIdMock: vi.fn(),
  readOrgIdMock: vi.fn(),
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

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditMock,
}));

vi.mock("@/lib/org/session", () => ({
  readOrganizationId: readOrgIdMock,
}));

vi.mock("@/lib/mongo/transactions", () => ({
  withMongoTransaction: withTxnMock,
  isMongoDuplicateKeyError: (err: unknown) =>
    Boolean(
      err &&
        typeof err === "object" &&
        (err as { code?: number }).code === 11000
    ),
  MongoTransactionError: class extends Error {
    code: string;
    status: number;
    constructor(message: string, opts: { code: string; status: number }) {
      super(message);
      this.code = opts.code;
      this.status = opts.status;
    }
  },
}));

vi.mock("@/lib/business/reassignLocation", () => ({
  assertLocationMovable: assertMovableMock,
  replaceBusinessLocationsAtomic: vi.fn(),
}));

vi.mock("@/lib/business/resolveLocationForCreate", () => ({
  resolveLocationForBusinessCreate: resolveLocationMock,
}));

vi.mock("@/lib/business/assignLocations", () => {
  class LocationAssignmentError extends Error {
    code: string;
    status: number;
    constructor(message: string, opts: { code: string; status: number }) {
      super(message);
      this.code = opts.code;
      this.status = opts.status;
    }
  }
  return {
    LocationAssignmentError,
    loadAssignableLocations: loadAssignableMock,
    assertAssignableLocations: assertAssignableMock,
    validateLocationAssignmentInput: validateLocationInputMock,
  };
});

vi.mock("@/lib/business/owners", () => {
  class OwnerAccountError extends Error {
    code: string;
    status: number;
    constructor(message: string, opts: { code: string; status: number }) {
      super(message);
      this.code = opts.code;
      this.status = opts.status;
    }
  }
  return {
    OwnerAccountError,
    upsertBusinessOwner: upsertOwnerMock,
    reassignBusinessOwner: vi.fn(),
  };
});

vi.mock("@/lib/groups/membership", () => ({
  GroupMembershipError: class extends Error {
    code = "group_error";
    status = 400;
  },
  setBusinessGroup: setGroupMock,
  refreshOwnersForBusinessGroupChange: refreshOwnersMock,
}));

vi.mock("@/lib/business/stats", () => ({
  clearReviewBusinessIdsForLocations: clearReviewsMock,
  syncReviewBusinessIdsForLocations: syncReviewsMock,
}));

vi.mock("@/models/Business", () => ({
  Business: {
    create: businessCreateMock,
    findById: businessFindByIdMock,
    find: vi.fn(),
  },
  BRAND_VOICES: ["friendly", "professional", "casual", "premium"],
  REPLY_MODES: ["manual", "auto"],
}));

vi.mock("@/models/Location", () => ({
  Location: { findById: locationFindByIdMock },
}));

vi.mock("@/models/Organization", () => ({
  Organization: { findById: orgFindByIdMock },
}));

vi.mock("@/models/Review", () => ({
  Review: { countDocuments: vi.fn() },
}));

vi.mock("@/models/User", () => ({
  User: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/lib/entitlements/plans", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entitlements/plans")>(
    "@/lib/entitlements/plans"
  );
  return actual;
});

import { POST } from "@/app/api/admin/businesses/route";
import { LocationAssignmentError } from "@/lib/business/assignLocations";
import { OwnerAccountError } from "@/lib/business/owners";

const SA = {
  user: {
    userId: new mongoose.Types.ObjectId().toString(),
    role: "superadmin" as const,
    email: "sa@example.com",
    businessIds: [] as string[],
  },
};

const ORG = new mongoose.Types.ObjectId();
const LOC = new mongoose.Types.ObjectId();
const BIZ = new mongoose.Types.ObjectId();

function makeLocDoc() {
  return {
    _id: LOC,
    orgId: ORG,
    businessId: null as mongoose.Types.ObjectId | null,
    googleLocationName: "accounts/1/locations/1",
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBizDoc() {
  return {
    _id: BIZ,
    name: "Cafe Test",
    replyMode: "manual",
    brandVoice: "friendly",
    preferredLanguage: "English",
    active: true,
    ownerUserId: null as mongoose.Types.ObjectId | null,
    locationIds: [LOC],
    googleLocationNames: ["accounts/1/locations/1"],
  };
}

describe("POST /api/admin/businesses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    requireSuperAdminMock.mockResolvedValue(SA);
    auditMock.mockReturnValue(undefined);
    readOrgIdMock.mockResolvedValue(null);
    assertMovableMock.mockResolvedValue({
      requiresReassign: false,
      conflict: null,
    });
    resolveLocationMock.mockResolvedValue({
      locationId: LOC.toString(),
      orgId: ORG.toString(),
      googleLocationName: "accounts/1/locations/1",
    });
    withTxnMock.mockImplementation(async (work: (s: unknown) => Promise<unknown>) =>
      work({ fake: true })
    );
    const locDoc = makeLocDoc();
    locationFindByIdMock.mockImplementation(() => ({
      session: () => ({
        exec: async () => locDoc,
      }),
      exec: async () => locDoc,
    }));
    const bizDoc = makeBizDoc();
    businessCreateMock.mockResolvedValue([bizDoc]);
    businessFindByIdMock.mockImplementation(() => ({
      session: () => ({
        exec: async () => bizDoc,
      }),
      exec: async () => bizDoc,
    }));
    upsertOwnerMock.mockResolvedValue({
      userId: new mongoose.Types.ObjectId(),
      created: true,
      linkedExisting: false,
      passwordSet: true,
    });
    setGroupMock.mockResolvedValue({
      previousGroupId: null,
      groupId: null,
    });
    refreshOwnersMock.mockResolvedValue(undefined);
    syncReviewsMock.mockResolvedValue(undefined);
    clearReviewsMock.mockResolvedValue(undefined);
  });

  it("rejects Business Admin", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden" },
        { status: 403 }
      ),
    });
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "X",
          locationId: LOC.toString(),
        }),
      })
    );
    expect(res.status).toBe(403);
    expect(withTxnMock).not.toHaveBeenCalled();
  });

  it("rejects unsigned-out / unauthorized callers", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "unauthorized" },
        { status: 401 }
      ),
    });
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X", locationId: LOC.toString() }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing business name", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  ", locationId: LOC.toString() }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(withTxnMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns structured 400 when location is required but missing", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No Location Biz" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("location_required");
    expect(withTxnMock).not.toHaveBeenCalled();
  });

  it("rejects invalid location ids via LocationAssignmentError", async () => {
    assertMovableMock.mockRejectedValue(
      new LocationAssignmentError("Invalid location id.", {
        code: "invalid_location_id",
        status: 400,
      })
    );
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad Loc",
          locationId: "not-an-id",
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_location_id");
    expect(withTxnMock).not.toHaveBeenCalled();
  });

  it("handles already-assigned locations safely without confirmReassign", async () => {
    assertMovableMock.mockRejectedValue(
      new LocationAssignmentError(
        "Location is already assigned to another business.",
        { code: "location_assigned", status: 409 }
      )
    );
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Conflict Biz",
          locationId: LOC.toString(),
        }),
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("location_assigned");
    expect(withTxnMock).not.toHaveBeenCalled();
    expect(businessCreateMock).not.toHaveBeenCalled();
  });

  it("allows Super Admin to create a business with valid input", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Cafe Test",
          locationId: LOC.toString(),
          brandVoice: "casual",
          planCode: "starter",
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.business.id).toBe(BIZ.toString());
    expect(body.business.name).toBe("Cafe Test");
    expect(withTxnMock).toHaveBeenCalled();
    expect(businessCreateMock).toHaveBeenCalled();
    expect(resolveLocationMock).toHaveBeenCalledWith(LOC.toString(), {
      allowAssigned: false,
    });
  });

  it("rolls back create when owner association fails inside the transaction", async () => {
    upsertOwnerMock.mockRejectedValue(
      new OwnerAccountError("Owner password must be at least 8 characters.", {
        code: "invalid_password",
        status: 400,
      })
    );
    // Simulate withMongoTransaction propagating the throw (rollback).
    withTxnMock.mockImplementation(async (work: (s: unknown) => Promise<unknown>) => {
      return work({ fake: true });
    });

    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Owner Fail Biz",
          locationId: LOC.toString(),
          ownerEmail: "owner@example.com",
          ownerPassword: "short",
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_password");
    expect(body.businessId).toBeUndefined();
    expect(upsertOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        session: expect.anything(),
      })
    );
  });

  it("does not leave orphaned assignments when Business.create fails in the transaction", async () => {
    const locDoc = makeLocDoc();
    locationFindByIdMock.mockImplementation(() => ({
      session: () => ({
        exec: async () => locDoc,
      }),
      exec: async () => locDoc,
    }));
    businessCreateMock.mockRejectedValue(new Error("insert failed"));

    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Txn Fail Biz",
          locationId: LOC.toString(),
        }),
      })
    );
    expect(res.status).toBe(500);
    // Location.save is only reached after Business.create succeeds.
    expect(locDoc.save).not.toHaveBeenCalled();
  });

  it("passes session into owner upsert so owner joins the create transaction", async () => {
    await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "With Owner",
          locationId: LOC.toString(),
          ownerEmail: "owner@example.com",
          ownerPassword: "password123",
        }),
      })
    );
    expect(upsertOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ.toString(),
        session: expect.anything(),
        requirePassword: true,
      })
    );
  });

  it("fails closed with 503 when Mongo transactions are unavailable", async () => {
    const { MongoTransactionError } = await import(
      "@/lib/mongo/transactions"
    );
    withTxnMock.mockRejectedValue(
      new MongoTransactionError(
        "MongoDB transactions are required for this operation.",
        { code: "transactions_required", status: 503 }
      )
    );
    const res = await POST(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "No Txn Biz",
          locationId: LOC.toString(),
        }),
      })
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("transactions_required");
    expect(businessCreateMock).not.toHaveBeenCalled();
  });
});
