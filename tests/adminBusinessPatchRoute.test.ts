import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  connectMock,
  businessFindByIdMock,
  cancelJobsMock,
  auditMock,
  replaceLocationsMock,
  upsertOwnerMock,
  reassignOwnerMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  connectMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  cancelJobsMock: vi.fn(),
  auditMock: vi.fn(),
  replaceLocationsMock: vi.fn(),
  upsertOwnerMock: vi.fn(),
  reassignOwnerMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  assertBusinessAccess: vi.fn(),
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

vi.mock("@/models/Business", () => ({
  Business: {
    findById: businessFindByIdMock,
  },
  BRAND_VOICES: [
    "friendly",
    "professional",
    "casual",
    "premium",
    "empathetic",
    "concise",
  ],
  REPLY_MODES: ["manual", "auto"],
}));

vi.mock("@/models/Review", () => ({
  Review: { countDocuments: vi.fn() },
}));

vi.mock("@/models/User", () => ({
  User: { findById: vi.fn() },
}));

vi.mock("@/lib/autoPublish/cancelJobs", () => ({
  cancelOpenAutoPublishJobsForBusiness: cancelJobsMock,
}));

vi.mock("@/lib/business/reassignLocation", () => ({
  replaceBusinessLocationsAtomic: replaceLocationsMock,
}));

vi.mock("@/lib/mongo/transactions", () => ({
  withMongoTransaction: async <T>(
    work: (session: { fake: true }) => Promise<T>
  ) => work({ fake: true }),
  MongoTransactionError: class extends Error {
    code = "transaction_failed";
    status = 500;
  },
}));

vi.mock("@/lib/business/assignLocations", () => ({
  assertAssignableLocations: vi.fn(),
  loadAssignableLocations: vi.fn(),
  LocationAssignmentError: class extends Error {
    code: string;
    status: number;
    constructor(message: string, opts: { code: string; status: number }) {
      super(message);
      this.code = opts.code;
      this.status = opts.status;
    }
  },
  validateLocationAssignmentInput: ({
    locationIds,
  }: {
    locationIds: unknown;
  }) =>
    Array.isArray(locationIds)
      ? locationIds.map(String).filter(Boolean)
      : [],
}));

vi.mock("@/lib/business/owners", () => {
  class OwnerAccountError extends Error {
    code: string;
    status: number;
    constructor(message: string, opts?: { code?: string; status?: number }) {
      super(message);
      this.code = opts?.code || "owner_error";
      this.status = opts?.status || 400;
    }
  }
  return {
    OwnerAccountError,
    reassignBusinessOwner: reassignOwnerMock,
    upsertBusinessOwner: upsertOwnerMock,
  };
});

vi.mock("@/lib/groups/membership", () => ({
  GroupMembershipError: class extends Error {
    code = "group_error";
    status = 400;
  },
  setBusinessGroup: vi.fn(),
}));

import { PATCH } from "@/app/api/admin/businesses/[businessId]/route";

const BIZ = new mongoose.Types.ObjectId().toString();
const SA = {
  user: {
    userId: new mongoose.Types.ObjectId().toString(),
    role: "superadmin" as const,
    email: "sa@example.com",
    businessIds: [] as string[],
  },
};

function makeBusinessDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(BIZ),
    name: "Demo Biz",
    orgId: new mongoose.Types.ObjectId(),
    active: true,
    status: "active",
    replyMode: "manual",
    brandVoice: "friendly",
    preferredLanguage: "English",
    locationIds: [] as mongoose.Types.ObjectId[],
    googleLocationNames: [] as string[],
    ownerUserId: null as mongoose.Types.ObjectId | null,
    plan: {
      code: "starter",
      displayName: "Starter",
      status: "active",
      notes: "",
      features: {
        reviewSync: true,
        aiDrafts: true,
        advancedAnalytics: false,
        automation: false,
      },
      limits: {
        maxLocations: 1,
        maxOwnerAccounts: 1,
        monthlyAiDraftQuota: 50,
      },
      usage: { aiDraftsThisPeriod: 0, periodStart: new Date() },
    },
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockFindById(doc: ReturnType<typeof makeBusinessDoc> | null) {
  businessFindByIdMock.mockImplementation(() => {
    const chain: {
      exec: () => Promise<typeof doc>;
      session: (s: unknown) => typeof chain;
      select: (fields: string) => {
        session: (s: unknown) => {
          lean: () => Promise<{ ownerUserId: unknown } | null>;
        };
        lean: () => Promise<{ ownerUserId: unknown } | null>;
      };
    } = {
      exec: async () => doc,
      session: () => chain,
      select: () => {
        const lean = async () =>
          doc ? { ownerUserId: doc.ownerUserId } : null;
        return {
          lean,
          session: () => ({ lean }),
        };
      },
    };
    return chain;
  });
}

describe("PATCH /api/admin/businesses/[businessId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    cancelJobsMock.mockResolvedValue(undefined);
    requireSuperAdminMock.mockResolvedValue(SA);
    auditMock.mockReturnValue(undefined);
  });

  it("rejects unauthorized callers", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "forbidden" },
        { status: 403 }
      ),
    });
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(403);
  });

  it("rejects invalid business ids", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/admin/businesses/not-an-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
      { params: Promise.resolve({ businessId: "not-an-id" }) }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("accepts empty body as a no-op update (does not crash)", async () => {
    const doc = makeBusinessDoc();
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "   ",
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(doc.save).toHaveBeenCalled();
    expect(doc.name).toBe("Demo Biz");
    expect(doc.brandVoice).toBe("friendly");
  });

  it("returns 400 for malformed JSON instead of 500", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_json");
    expect(businessFindByIdMock).not.toHaveBeenCalled();
  });

  it("rejects empty name when name is provided", async () => {
    const doc = makeBusinessDoc();
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_name");
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("rejects empty locationIds without confirmClearLocations", async () => {
    const doc = makeBusinessDoc({
      locationIds: [new mongoose.Types.ObjectId()],
    });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationIds: [] }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("confirm_clear_locations_required");
  });

  it("updates name without clearing other fields", async () => {
    const doc = makeBusinessDoc({
      brandVoice: "premium",
      preferredLanguage: "English",
    });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed Biz" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    expect(doc.name).toBe("Renamed Biz");
    expect(doc.brandVoice).toBe("premium");
    expect(doc.preferredLanguage).toBe("English");
  });

  it("omitting locationIds leaves assignments unchanged", async () => {
    const loc = new mongoose.Types.ObjectId();
    const doc = makeBusinessDoc({
      locationIds: [loc],
      googleLocationNames: ["accounts/1/locations/1"],
    });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandVoice: "casual" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    expect(doc.locationIds).toEqual([loc]);
    expect(doc.googleLocationNames).toEqual(["accounts/1/locations/1"]);
    expect(doc.brandVoice).toBe("casual");
  });

  it("materializes suspended lifecycle for legacy docs missing status", async () => {
    const doc = makeBusinessDoc({
      status: undefined,
      active: false,
    });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Still Suspended" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    expect(doc.name).toBe("Still Suspended");
    expect(doc.status).toBe("suspended");
    expect(doc.active).toBe(false);
  });

  it("keeps suspended businesses suspended on unrelated field updates", async () => {
    const doc = makeBusinessDoc({
      status: "suspended",
      active: false,
      brandVoice: "friendly",
    });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredLanguage: "Hindi" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    expect(doc.status).toBe("suspended");
    expect(doc.active).toBe(false);
    expect(doc.preferredLanguage).toBe("Hindi");
    expect(doc.brandVoice).toBe("friendly");
  });

  it("suspends via lifecycleAction and cancels auto-publish jobs", async () => {
    const doc = makeBusinessDoc({ status: "active", active: true });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lifecycleAction: "suspend" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    expect(doc.status).toBe("suspended");
    expect(doc.active).toBe(false);
    expect(cancelJobsMock).toHaveBeenCalled();
  });

  it("does not change plan when planCode is omitted", async () => {
    const doc = makeBusinessDoc({
      plan: {
        code: "growth",
        displayName: "Growth",
        status: "active",
        notes: "keep-me",
        features: {
          reviewSync: true,
          aiDrafts: true,
          advancedAnalytics: true,
          automation: false,
        },
        limits: {
          maxLocations: 1,
          maxOwnerAccounts: 2,
          monthlyAiDraftQuota: 200,
        },
        usage: { aiDraftsThisPeriod: 3, periodStart: new Date("2026-01-01") },
      },
    });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Plan Untouched" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    expect(doc.plan.code).toBe("growth");
    expect(doc.plan.notes).toBe("keep-me");
    expect(doc.plan.limits.monthlyAiDraftQuota).toBe(200);
    expect(doc.plan.usage.aiDraftsThisPeriod).toBe(3);
  });

  it("applies planCode only when intentionally provided", async () => {
    const doc = makeBusinessDoc();
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planCode: "growth" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    expect(doc.plan.code).toBe("growth");
    expect(doc.plan.displayName).toBe("Growth");
  });

  it("does not save business fields when owner association fails", async () => {
    const { OwnerAccountError } = await import("@/lib/business/owners");
    upsertOwnerMock.mockRejectedValue(
      new OwnerAccountError("Owner password must be at least 8 characters.", {
        code: "invalid_password",
        status: 400,
      })
    );
    const doc = makeBusinessDoc({ name: "Demo Biz", ownerUserId: null });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Should Not Persist",
          ownerEmail: "new-owner@example.com",
          ownerPassword: "short",
        }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
    expect(replaceLocationsMock).not.toHaveBeenCalled();
  });

  it("does not call location replace when owner fails first", async () => {
    const { OwnerAccountError } = await import("@/lib/business/owners");
    upsertOwnerMock.mockRejectedValue(
      new OwnerAccountError("A valid owner email is required.", {
        code: "invalid_email",
        status: 400,
      })
    );
    const loc = new mongoose.Types.ObjectId().toString();
    const doc = makeBusinessDoc({ ownerUserId: null });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationIds: [loc],
          ownerEmail: "bad",
          ownerPassword: "password123",
        }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(400);
    expect(replaceLocationsMock).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("passes the same transaction session to owner and location helpers", async () => {
    const { LocationAssignmentError } = await import(
      "@/lib/business/assignLocations"
    );
    upsertOwnerMock.mockResolvedValue({
      userId: new mongoose.Types.ObjectId(),
      created: true,
      linkedExisting: false,
      passwordSet: true,
    });
    replaceLocationsMock.mockRejectedValue(
      new LocationAssignmentError("Location not found.", {
        code: "location_not_found",
        status: 404,
      })
    );
    const loc = new mongoose.Types.ObjectId().toString();
    const doc = makeBusinessDoc({ ownerUserId: null });
    mockFindById(doc);
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationIds: [loc],
          ownerEmail: "owner@example.com",
          ownerPassword: "password123",
        }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(404);
    expect(upsertOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.anything() })
    );
    expect(replaceLocationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.anything() })
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("clears locations when locationIds [] and confirmClearLocations true", async () => {
    const prior = new mongoose.Types.ObjectId();
    const doc = makeBusinessDoc({
      locationIds: [prior],
      googleLocationNames: ["accounts/1/locations/1"],
    });
    mockFindById(doc);
    replaceLocationsMock.mockResolvedValue({
      locationObjectIds: [],
      googleLocationNames: [],
    });
    const res = await PATCH(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationIds: [],
          confirmClearLocations: true,
        }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(200);
    expect(replaceLocationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        locationIds: [],
        session: expect.anything(),
      })
    );
    expect(doc.locationIds).toEqual([]);
    expect(doc.googleLocationNames).toEqual([]);
    expect(doc.save).toHaveBeenCalled();
  });
});
