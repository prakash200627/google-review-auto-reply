import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const { connectMock, findByIdMock, findOneAndUpdateMock, updateOneMock } =
  vi.hoisted(() => ({
    connectMock: vi.fn(),
    findByIdMock: vi.fn(),
    findOneAndUpdateMock: vi.fn(),
    updateOneMock: vi.fn(),
  }));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: {
    findById: findByIdMock,
    findOneAndUpdate: findOneAndUpdateMock,
    updateOne: updateOneMock,
  },
}));

import {
  EntitlementError,
  assertFeatureEnabled,
  assertReviewSyncAllowed,
  loadBusinessPlan,
  releaseAiDraftQuota,
  toPlanSnapshot,
  tryReserveAiDraftQuota,
} from "@/lib/entitlements/enforce";
import {
  PLAN_CATALOG,
  planAllowsOperations,
} from "@/lib/entitlements/plans";

const BIZ = new mongoose.Types.ObjectId().toString();

function leanPlan(plan: Record<string, unknown>) {
  findByIdMock.mockReturnValue({
    select: () => ({
      lean: async () => ({ _id: BIZ, active: true, plan }),
    }),
  });
}

describe("plan catalog and deny policy", () => {
  it("documents free plan without AI drafts", () => {
    expect(PLAN_CATALOG.free.features.aiDrafts).toBe(false);
    expect(PLAN_CATALOG.free.limits.monthlyAiDraftQuota).toBe(0);
  });

  it("only active plans allow operations", () => {
    expect(planAllowsOperations("active")).toBe(true);
    expect(planAllowsOperations("suspended")).toBe(false);
    expect(planAllowsOperations("expired")).toBe(false);
  });
});

describe("entitlement enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("rejects suspended plans for AI drafts", async () => {
    leanPlan({
      code: "starter",
      displayName: "Starter",
      status: "suspended",
      features: { ...PLAN_CATALOG.starter.features },
      limits: { ...PLAN_CATALOG.starter.limits },
      usage: { aiDraftsThisPeriod: 0, periodStart: new Date() },
    });

    await expect(tryReserveAiDraftQuota(BIZ)).rejects.toMatchObject({
      code: "plan_inactive",
      status: 403,
    });
  });

  it("rejects expired plans for review sync", async () => {
    leanPlan({
      code: "growth",
      status: "expired",
      features: { ...PLAN_CATALOG.growth.features },
      limits: { ...PLAN_CATALOG.growth.limits },
      usage: { aiDraftsThisPeriod: 0, periodStart: new Date() },
    });

    await expect(assertReviewSyncAllowed(BIZ)).rejects.toMatchObject({
      code: "plan_inactive",
    });
  });

  it("rejects when AI drafts feature is disabled", async () => {
    leanPlan({
      code: "free",
      status: "active",
      features: { ...PLAN_CATALOG.free.features },
      limits: { ...PLAN_CATALOG.free.limits },
      usage: { aiDraftsThisPeriod: 0, periodStart: new Date() },
    });

    await expect(tryReserveAiDraftQuota(BIZ)).rejects.toMatchObject({
      code: "feature_disabled",
    });
  });

  it("rejects when monthly AI draft quota is exhausted", async () => {
    leanPlan({
      code: "starter",
      status: "active",
      features: { ...PLAN_CATALOG.starter.features },
      limits: { monthlyAiDraftQuota: 50, maxLocations: 1, maxOwnerAccounts: 1 },
      usage: {
        aiDraftsThisPeriod: 50,
        periodStart: new Date(),
      },
    });
    findOneAndUpdateMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    await expect(tryReserveAiDraftQuota(BIZ)).rejects.toMatchObject({
      code: "quota_exhausted",
    });
  });

  it("reserves quota with a conditional update when under limit", async () => {
    leanPlan({
      code: "starter",
      status: "active",
      features: { ...PLAN_CATALOG.starter.features },
      limits: { monthlyAiDraftQuota: 50, maxLocations: 1, maxOwnerAccounts: 1 },
      usage: {
        aiDraftsThisPeriod: 10,
        periodStart: new Date(),
      },
    });
    findOneAndUpdateMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: BIZ }),
      }),
    });

    await expect(tryReserveAiDraftQuota(BIZ)).resolves.toBeUndefined();
    expect(findOneAndUpdateMock).toHaveBeenCalledWith(
      {
        _id: BIZ,
        "plan.usage.aiDraftsThisPeriod": { $lt: 50 },
      },
      { $inc: { "plan.usage.aiDraftsThisPeriod": 1 } },
      expect.any(Object)
    );
  });

  it("releases reserved quota after failures", async () => {
    updateOneMock.mockResolvedValue({ modifiedCount: 1 });
    await releaseAiDraftQuota(BIZ);
    expect(updateOneMock).toHaveBeenCalledWith(
      {
        _id: BIZ,
        "plan.usage.aiDraftsThisPeriod": { $gt: 0 },
      },
      { $inc: { "plan.usage.aiDraftsThisPeriod": -1 } }
    );
  });

  it("snapshots plans without exposing secrets", () => {
    const snap = toPlanSnapshot({
      code: "growth",
      status: "active",
      features: PLAN_CATALOG.growth.features,
      limits: PLAN_CATALOG.growth.limits,
      usage: { aiDraftsThisPeriod: 3, periodStart: new Date("2026-01-01") },
      notes: "demo",
    });
    expect(snap.code).toBe("growth");
    expect(snap.usage.aiDraftsThisPeriod).toBe(3);
    expect(JSON.stringify(snap)).not.toMatch(/token|password|secret/i);
  });

  it("assertFeatureEnabled throws EntitlementError for inactive plans", () => {
    expect(() =>
      assertFeatureEnabled(
        {
          code: "starter",
          displayName: "Starter",
          status: "suspended",
          features: PLAN_CATALOG.starter.features,
          limits: PLAN_CATALOG.starter.limits,
          usage: { aiDraftsThisPeriod: 0, periodStart: null },
          assignedAt: null,
          notes: "",
        },
        "reviewSync"
      )
    ).toThrow(EntitlementError);
  });

  it("loadBusinessPlan rejects invalid ids", async () => {
    await expect(loadBusinessPlan("bad")).rejects.toMatchObject({
      code: "invalid_id",
    });
  });
});
