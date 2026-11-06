import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadBusinessPlanMock } = vi.hoisted(() => ({
  loadBusinessPlanMock: vi.fn(),
}));

vi.mock("@/lib/entitlements/enforce", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/entitlements/enforce")
  >("@/lib/entitlements/enforce");
  return {
    ...actual,
    loadBusinessPlan: loadBusinessPlanMock,
  };
});

import { assertBusinessOperationAllowed } from "@/lib/auth/operationalGuard";
import { PLAN_CATALOG } from "@/lib/entitlements/plans";

describe("assertBusinessOperationAllowed staff manage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadBusinessPlanMock.mockResolvedValue({
      businessId: "b1",
      plan: {
        code: "starter",
        displayName: "Starter",
        status: "active",
        features: {
          ...PLAN_CATALOG.starter.features,
          advancedAnalytics: false,
        },
        limits: PLAN_CATALOG.starter.limits,
        usage: { aiDraftsThisPeriod: 0, periodStart: null },
        assignedAt: null,
        notes: "",
      },
    });
  });

  it("allows Super Admin manage_seo without advancedAnalytics", async () => {
    await expect(
      assertBusinessOperationAllowed({
        businessId: "b1",
        business: { status: "active", active: true },
        action: "manage_seo",
        actorRole: "superadmin",
      })
    ).resolves.toBeUndefined();
    expect(loadBusinessPlanMock).not.toHaveBeenCalled();
  });

  it("allows Super Admin read_seo on suspended business without entitlement", async () => {
    await expect(
      assertBusinessOperationAllowed({
        businessId: "b1",
        business: { status: "suspended", active: false },
        action: "read_seo",
        actorRole: "superadmin",
      })
    ).resolves.toBeUndefined();
    expect(loadBusinessPlanMock).not.toHaveBeenCalled();
  });

  it("still gates owner read_seo on advancedAnalytics", async () => {
    await expect(
      assertBusinessOperationAllowed({
        businessId: "b1",
        business: { status: "active", active: true },
        action: "read_seo",
        actorRole: "business_owner",
      })
    ).rejects.toMatchObject({ code: "feature_disabled", status: 403 });
  });
});
