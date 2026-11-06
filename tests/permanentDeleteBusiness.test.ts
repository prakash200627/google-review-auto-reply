import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { PERMANENT_DELETE_CONFIRM_PHRASE } from "@/lib/business/permanentDeleteTypes";

const {
  connectMock,
  businessFindByIdMock,
  businessFindOneAndUpdateMock,
  businessDeleteOneMock,
  businessCountDocumentsMock,
  locationCountMock,
  locationUpdateManyMock,
  reviewCountMock,
  reviewUpdateManyMock,
  autoPublishCountMock,
  autoPublishDeleteManyMock,
  seoKeywordDeleteManyMock,
  seoKeywordCountMock,
  seoRankingDeleteManyMock,
  seoRankingCountMock,
  gmbDeleteManyMock,
  gmbCountMock,
  flagDeleteManyMock,
  flagCountMock,
  paymentCountMock,
  auditCountMock,
  googleConnCountMock,
  googleConnDeleteManyMock,
  oauthDeleteManyMock,
  oauthCountMock,
  userFindByIdMock,
  userDeleteOneMock,
  orgCountMock,
  cancelJobsMock,
  auditLogMock,
  requireSuperAdminMock,
  assertBusinessAccessMock,
  assertMutationOriginMock,
  isAuthUserMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  businessFindOneAndUpdateMock: vi.fn(),
  businessDeleteOneMock: vi.fn(),
  businessCountDocumentsMock: vi.fn(),
  locationCountMock: vi.fn(),
  locationUpdateManyMock: vi.fn(),
  reviewCountMock: vi.fn(),
  reviewUpdateManyMock: vi.fn(),
  autoPublishCountMock: vi.fn(),
  autoPublishDeleteManyMock: vi.fn(),
  seoKeywordDeleteManyMock: vi.fn(),
  seoKeywordCountMock: vi.fn(),
  seoRankingDeleteManyMock: vi.fn(),
  seoRankingCountMock: vi.fn(),
  gmbDeleteManyMock: vi.fn(),
  gmbCountMock: vi.fn(),
  flagDeleteManyMock: vi.fn(),
  flagCountMock: vi.fn(),
  paymentCountMock: vi.fn(),
  auditCountMock: vi.fn(),
  googleConnCountMock: vi.fn(),
  googleConnDeleteManyMock: vi.fn(),
  oauthDeleteManyMock: vi.fn(),
  oauthCountMock: vi.fn(),
  userFindByIdMock: vi.fn(),
  userDeleteOneMock: vi.fn(),
  orgCountMock: vi.fn(),
  cancelJobsMock: vi.fn(),
  auditLogMock: vi.fn(),
  requireSuperAdminMock: vi.fn(),
  assertBusinessAccessMock: vi.fn(),
  assertMutationOriginMock: vi.fn(),
  isAuthUserMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditLogMock,
}));

vi.mock("@/lib/autoPublish/cancelJobs", () => ({
  cancelOpenAutoPublishJobsForBusiness: cancelJobsMock,
}));

vi.mock("@/models/Business", () => ({
  Business: {
    findById: businessFindByIdMock,
    findOneAndUpdate: businessFindOneAndUpdateMock,
    deleteOne: businessDeleteOneMock,
    countDocuments: businessCountDocumentsMock,
  },
}));

vi.mock("@/models/Location", () => ({
  Location: {
    countDocuments: locationCountMock,
    updateMany: locationUpdateManyMock,
  },
}));

vi.mock("@/models/Review", () => ({
  Review: {
    countDocuments: reviewCountMock,
    updateMany: reviewUpdateManyMock,
  },
}));

vi.mock("@/models/AutoPublishJob", () => ({
  AutoPublishJob: {
    countDocuments: autoPublishCountMock,
    deleteMany: autoPublishDeleteManyMock,
  },
}));

vi.mock("@/models/SeoKeyword", () => ({
  SeoKeyword: {
    countDocuments: seoKeywordCountMock,
    deleteMany: seoKeywordDeleteManyMock,
  },
}));

vi.mock("@/models/SeoRanking", () => ({
  SeoRanking: {
    countDocuments: seoRankingCountMock,
    deleteMany: seoRankingDeleteManyMock,
  },
}));

vi.mock("@/models/GmbServiceJob", () => ({
  GmbServiceJob: {
    countDocuments: gmbCountMock,
    deleteMany: gmbDeleteManyMock,
  },
}));

vi.mock("@/models/FakeReviewFlag", () => ({
  FakeReviewFlag: {
    countDocuments: flagCountMock,
    deleteMany: flagDeleteManyMock,
  },
}));

vi.mock("@/models/BusinessMedia", () => ({
  BusinessMedia: {
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
  },
}));

vi.mock("@/models/ManualPayment", () => ({
  ManualPayment: {
    countDocuments: paymentCountMock,
  },
}));

vi.mock("@/models/AuditEvent", () => ({
  AuditEvent: {
    countDocuments: auditCountMock,
  },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: {
    countDocuments: googleConnCountMock,
    deleteMany: googleConnDeleteManyMock,
  },
}));

vi.mock("@/models/OAuthState", () => ({
  OAuthState: {
    countDocuments: oauthCountMock,
    deleteMany: oauthDeleteManyMock,
  },
}));

vi.mock("@/models/User", () => ({
  User: {
    findById: userFindByIdMock,
    deleteOne: userDeleteOneMock,
  },
}));

vi.mock("@/models/Organization", () => ({
  Organization: {
    countDocuments: orgCountMock,
  },
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  assertBusinessAccess: assertBusinessAccessMock,
  isAuthUser: isAuthUserMock,
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: assertMutationOriginMock,
}));

import {
  executePermanentDelete,
  PermanentDeleteError,
  previewPermanentDelete,
} from "@/lib/business/permanentDelete";
import { POST as permanentDeletePost } from "@/app/api/admin/businesses/[businessId]/permanent-delete/route";

const ORG_ID = new mongoose.Types.ObjectId();
const BIZ_ID = new mongoose.Types.ObjectId();
const OTHER_BIZ_ID = new mongoose.Types.ObjectId();
const OWNER_ID = new mongoose.Types.ObjectId();
const SA_ID = new mongoose.Types.ObjectId().toString();

function archivedBusiness(overrides: Record<string, unknown> = {}) {
  return {
    _id: BIZ_ID,
    name: "Test Cafe",
    orgId: ORG_ID,
    status: "archived",
    active: false,
    ownerUserId: OWNER_ID,
    permanentDelete: { inProgress: false },
    autoPublish: { enabled: false },
    ...overrides,
  };
}

function leanExec(doc: unknown) {
  return {
    lean: async () => doc,
    exec: async () => doc,
    select: () => ({
      lean: async () => doc,
      exec: async () => doc,
    }),
  };
}

function zeroCounts() {
  locationCountMock.mockResolvedValue(0);
  reviewCountMock.mockResolvedValue(0);
  autoPublishCountMock.mockResolvedValue(0);
  seoKeywordCountMock.mockResolvedValue(0);
  seoRankingCountMock.mockResolvedValue(0);
  gmbCountMock.mockResolvedValue(0);
  flagCountMock.mockResolvedValue(0);
  paymentCountMock.mockResolvedValue(0);
  auditCountMock.mockResolvedValue(0);
  googleConnCountMock.mockResolvedValue(0);
  oauthCountMock.mockResolvedValue(0);
  orgCountMock.mockResolvedValue(1);
  businessCountDocumentsMock.mockResolvedValue(1);
}

describe("permanentDeleteBusiness service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    cancelJobsMock.mockResolvedValue(0);
    zeroCounts();
    locationUpdateManyMock.mockResolvedValue({ modifiedCount: 0 });
    reviewUpdateManyMock.mockResolvedValue({ modifiedCount: 0 });
    autoPublishDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    seoKeywordDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    seoRankingDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    gmbDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    flagDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    googleConnDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    oauthDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    businessDeleteOneMock.mockResolvedValue({ deletedCount: 1 });
    userFindByIdMock.mockReturnValue(leanExec(null));
  });

  it("rejects non-superadmin actors", async () => {
    businessFindByIdMock.mockReturnValue(leanExec(archivedBusiness()));
    await expect(
      executePermanentDelete({
        businessId: String(BIZ_ID),
        confirmName: "Test Cafe",
        confirmPermanentDelete: true,
        confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
        actor: { actorId: SA_ID, actorRole: "business_owner" },
      })
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("rejects wrong business name", async () => {
    businessFindByIdMock.mockReturnValue({
      exec: async () => archivedBusiness(),
    });
    await expect(
      executePermanentDelete({
        businessId: String(BIZ_ID),
        confirmName: "Wrong Name",
        confirmPermanentDelete: true,
        confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
        actor: { actorId: SA_ID, actorRole: "superadmin" },
      })
    ).rejects.toMatchObject({ code: "confirm_name_mismatch", status: 400 });
  });

  it("rejects missing second confirmation", async () => {
    businessFindByIdMock.mockReturnValue({
      exec: async () => archivedBusiness(),
    });
    await expect(
      executePermanentDelete({
        businessId: String(BIZ_ID),
        confirmName: "Test Cafe",
        confirmPermanentDelete: false,
        confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
        actor: { actorId: SA_ID, actorRole: "superadmin" },
      })
    ).rejects.toMatchObject({ code: "confirm_second_required", status: 400 });
  });

  it("rejects when business is not archived", async () => {
    businessFindByIdMock.mockReturnValue({
      exec: async () => archivedBusiness({ status: "active", active: true }),
    });
    await expect(
      executePermanentDelete({
        businessId: String(BIZ_ID),
        confirmName: "Test Cafe",
        confirmPermanentDelete: true,
        confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
        actor: { actorId: SA_ID, actorRole: "superadmin" },
      })
    ).rejects.toMatchObject({ code: "require_archived", status: 409 });
  });

  it("rejects duplicate concurrent deletion without resume", async () => {
    businessFindByIdMock.mockReturnValue({
      exec: async () =>
        archivedBusiness({
          permanentDelete: { inProgress: true, startedAt: new Date() },
        }),
    });
    await expect(
      executePermanentDelete({
        businessId: String(BIZ_ID),
        confirmName: "Test Cafe",
        confirmPermanentDelete: true,
        confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
        actor: { actorId: SA_ID, actorRole: "superadmin" },
      })
    ).rejects.toMatchObject({ code: "deletion_in_progress", status: 409 });
  });

  it("rejects when unsafe in-flight publish claims exist", async () => {
    businessFindByIdMock.mockReturnValue({
      exec: async () => archivedBusiness(),
    });
    autoPublishCountMock.mockImplementation(async (q: { status?: string }) =>
      q?.status === "processing" ? 1 : 0
    );
    await expect(
      executePermanentDelete({
        businessId: String(BIZ_ID),
        confirmName: "Test Cafe",
        confirmPermanentDelete: true,
        confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
        actor: { actorId: SA_ID, actorRole: "superadmin" },
      })
    ).rejects.toMatchObject({ code: "unsafe_in_flight", status: 409 });
  });

  it("Super Admin can delete; keeps payments, audits, org, platform connection, sibling biz", async () => {
    const biz = archivedBusiness();
    businessFindByIdMock.mockReturnValue({ exec: async () => biz });
    businessFindOneAndUpdateMock.mockReturnValue({
      exec: async () => ({ ...biz, permanentDelete: { inProgress: true } }),
    });
    paymentCountMock.mockResolvedValue(3);
    auditCountMock.mockResolvedValue(12);
    orgCountMock.mockResolvedValue(1);
    googleConnCountMock.mockImplementation(async (q: { connectionSource?: string }) =>
      q?.connectionSource === "platform" ? 1 : 0
    );
    businessCountDocumentsMock.mockResolvedValue(2);
    locationUpdateManyMock.mockResolvedValue({ modifiedCount: 1 });
    reviewUpdateManyMock.mockResolvedValue({ modifiedCount: 4 });
    autoPublishDeleteManyMock.mockResolvedValue({ deletedCount: 2 });
    cancelJobsMock.mockResolvedValue(2);

    const ownerDoc = {
      _id: OWNER_ID,
      email: "owner@example.com",
      role: "business_owner",
      businessIds: [BIZ_ID, OTHER_BIZ_ID],
      save: vi.fn(async function save(this: { businessIds: mongoose.Types.ObjectId[] }) {
        return this;
      }),
    };
    userFindByIdMock.mockReturnValue({ exec: async () => ownerDoc });

    const result = await executePermanentDelete({
      businessId: String(BIZ_ID),
      confirmName: "Test Cafe",
      confirmPermanentDelete: true,
      confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
      actor: { actorId: SA_ID, actorRole: "superadmin" },
    });

    expect(result.alreadyDeleted).toBe(false);
    expect(result.deleted.business).toBe(1);
    expect(result.deleted.autoPublishJobs).toBe(2);
    expect(result.retained.manualPayments).toBe(3);
    expect(result.retained.auditEvents).toBe(12);
    expect(result.retained.organizations).toBe(1);
    expect(result.retained.platformGoogleConnections).toBe(1);
    expect(result.retained.siblingBusinesses).toBe(2);
    expect(result.ownersDeleted).toBe(0);
    expect(result.ownersUnlinked).toBe(1);
    expect(userDeleteOneMock).not.toHaveBeenCalled();
    expect(ownerDoc.save).toHaveBeenCalled();
    expect(ownerDoc.businessIds.map(String)).toEqual([String(OTHER_BIZ_ID)]);
    expect(googleConnDeleteManyMock).toHaveBeenCalledWith({
      businessId: String(BIZ_ID),
      connectionSource: "business_owner",
    });
    expect(locationUpdateManyMock).toHaveBeenCalledWith(
      { businessId: String(BIZ_ID) },
      { $set: { businessId: null } }
    );
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "business.permanent_delete",
        success: true,
      })
    );
  });

  it("deletes owner account only when it has no other businesses", async () => {
    const biz = archivedBusiness();
    businessFindByIdMock.mockReturnValue({ exec: async () => biz });
    businessFindOneAndUpdateMock.mockReturnValue({
      exec: async () => ({ ...biz, permanentDelete: { inProgress: true } }),
    });
    const ownerDoc = {
      _id: OWNER_ID,
      email: "solo@example.com",
      role: "business_owner",
      businessIds: [BIZ_ID],
      save: vi.fn(),
    };
    userFindByIdMock.mockReturnValue({ exec: async () => ownerDoc });
    userDeleteOneMock.mockResolvedValue({ deletedCount: 1 });

    const result = await executePermanentDelete({
      businessId: String(BIZ_ID),
      confirmName: "Test Cafe",
      confirmPermanentDelete: true,
      confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
      actor: { actorId: SA_ID, actorRole: "superadmin" },
    });

    expect(result.ownersDeleted).toBe(1);
    expect(userDeleteOneMock).toHaveBeenCalledWith({
      _id: OWNER_ID,
      role: "business_owner",
    });
    expect(ownerDoc.save).not.toHaveBeenCalled();
  });

  it("is idempotent when business is already gone", async () => {
    businessFindByIdMock.mockReturnValue({ exec: async () => null });
    const result = await executePermanentDelete({
      businessId: String(BIZ_ID),
      confirmName: "anything",
      confirmPermanentDelete: true,
      confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
      actor: { actorId: SA_ID, actorRole: "superadmin" },
    });
    expect(result.alreadyDeleted).toBe(true);
    expect(businessDeleteOneMock).not.toHaveBeenCalled();
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "already_deleted",
        success: true,
      })
    );
  });

  it("leaves lock for partial failure and allows resume retry", async () => {
    const biz = archivedBusiness();
    businessFindByIdMock.mockReturnValue({ exec: async () => biz });
    businessFindOneAndUpdateMock.mockReturnValue({
      exec: async () => ({ ...biz, permanentDelete: { inProgress: true } }),
    });
    cancelJobsMock.mockResolvedValue(0);
    autoPublishDeleteManyMock.mockRejectedValue(new Error("mongo blip"));

    await expect(
      executePermanentDelete({
        businessId: String(BIZ_ID),
        confirmName: "Test Cafe",
        confirmPermanentDelete: true,
        confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
        actor: { actorId: SA_ID, actorRole: "superadmin" },
      })
    ).rejects.toMatchObject({ code: "delete_partial_failure", status: 500 });

    expect(businessDeleteOneMock).not.toHaveBeenCalled();
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "delete_partial_failure",
      })
    );

    // Resume path acquires lock again and completes.
    autoPublishDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    businessFindByIdMock.mockReturnValue({
      exec: async () =>
        archivedBusiness({
          permanentDelete: { inProgress: true },
        }),
    });
    businessFindOneAndUpdateMock.mockReturnValue({
      exec: async () =>
        archivedBusiness({
          permanentDelete: { inProgress: true },
        }),
    });

    const resumed = await executePermanentDelete({
      businessId: String(BIZ_ID),
      confirmName: "Test Cafe",
      confirmPermanentDelete: true,
      confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
      resume: true,
      actor: { actorId: SA_ID, actorRole: "superadmin" },
    });
    expect(resumed.deleted.business).toBe(1);
  });

  it("preview blocks non-archived businesses", async () => {
    businessFindByIdMock.mockReturnValue(
      leanExec(archivedBusiness({ status: "suspended", active: false }))
    );
    userFindByIdMock.mockReturnValue(leanExec(null));
    const preview = await previewPermanentDelete(String(BIZ_ID));
    expect(preview.canDelete).toBe(false);
    expect(preview.blockers[0]).toMatch(/archived/i);
  });
});

describe("permanent-delete API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    zeroCounts();
    assertMutationOriginMock.mockReturnValue({ ok: true });
    isAuthUserMock.mockImplementation(
      (v: { user?: unknown; response?: unknown }) => Boolean(v && "user" in v)
    );
  });

  it("Owner cannot delete via API (Super Admin required)", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          success: false,
          code: "forbidden",
          message: "Super Admin access required.",
        }),
        { status: 403 }
      ),
    });
    isAuthUserMock.mockReturnValue(false);

    const res = await permanentDeletePost(
      new Request("http://localhost/api/admin/businesses/x/permanent-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmName: "Test Cafe",
          confirmPermanentDelete: true,
          confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
        }),
      }),
      { params: Promise.resolve({ businessId: String(BIZ_ID) }) }
    );

    expect(res.status).toBe(403);
    expect(assertBusinessAccessMock).not.toHaveBeenCalled();
  });

  it("Super Admin request reaches deletion after access check", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: { userId: SA_ID, role: "superadmin", email: "sa@example.com" },
    });
    isAuthUserMock.mockReturnValue(true);
    assertBusinessAccessMock.mockResolvedValue({
      ok: true,
      business: archivedBusiness(),
    });

    const biz = archivedBusiness();
    businessFindByIdMock.mockReturnValue({ exec: async () => biz });
    businessFindOneAndUpdateMock.mockReturnValue({
      exec: async () => ({ ...biz, permanentDelete: { inProgress: true } }),
    });
    userFindByIdMock.mockReturnValue({ exec: async () => null });

    const res = await permanentDeletePost(
      new Request(
        `http://localhost/api/admin/businesses/${String(BIZ_ID)}/permanent-delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost" },
          body: JSON.stringify({
            confirmName: "Test Cafe",
            confirmPermanentDelete: true,
            confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
          }),
        }
      ),
      { params: Promise.resolve({ businessId: String(BIZ_ID) }) }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(assertBusinessAccessMock).toHaveBeenCalled();
  });

  it("wrong confirmations are rejected by the server even for Super Admin", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: { userId: SA_ID, role: "superadmin", email: "sa@example.com" },
    });
    isAuthUserMock.mockReturnValue(true);
    assertBusinessAccessMock.mockResolvedValue({
      ok: true,
      business: archivedBusiness(),
    });
    businessFindByIdMock.mockReturnValue({
      exec: async () => archivedBusiness(),
    });

    const res = await permanentDeletePost(
      new Request(
        `http://localhost/api/admin/businesses/${String(BIZ_ID)}/permanent-delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmName: "Test Cafe",
            confirmPermanentDelete: false,
            confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
          }),
        }
      ),
      { params: Promise.resolve({ businessId: String(BIZ_ID) }) }
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("confirm_second_required");
  });
});

describe("auto-publish after permanent delete", () => {
  it("cancels open jobs and deletes AutoPublishJob rows before removing the business", async () => {
    const biz = archivedBusiness();
    businessFindByIdMock.mockReturnValue({ exec: async () => biz });
    businessFindOneAndUpdateMock.mockReturnValue({
      exec: async () => ({ ...biz, permanentDelete: { inProgress: true } }),
    });
    cancelJobsMock.mockResolvedValue(3);
    autoPublishDeleteManyMock.mockResolvedValue({ deletedCount: 5 });
    userFindByIdMock.mockReturnValue({ exec: async () => null });

    const result = await executePermanentDelete({
      businessId: String(BIZ_ID),
      confirmName: "Test Cafe",
      confirmPermanentDelete: true,
      confirmPhrase: PERMANENT_DELETE_CONFIRM_PHRASE,
      actor: { actorId: SA_ID, actorRole: "superadmin" },
    });

    expect(cancelJobsMock).toHaveBeenCalledWith(
      String(BIZ_ID),
      "business_permanent_delete"
    );
    expect(autoPublishDeleteManyMock).toHaveBeenCalledWith({
      businessId: String(BIZ_ID),
    });
    expect(result.deleted.autoPublishCancelled).toBe(3);
    expect(result.deleted.autoPublishJobs).toBe(5);
    // Business removed last — processor findById would return null and cancel
    // any stale claim with business_unavailable (see lib/autoPublish/processor.ts).
    expect(businessDeleteOneMock).toHaveBeenCalled();
    const cancelOrder = cancelJobsMock.mock.invocationCallOrder[0]!;
    const deleteBizOrder = businessDeleteOneMock.mock.invocationCallOrder[0]!;
    expect(cancelOrder).toBeLessThan(deleteBizOrder);
  });
});
