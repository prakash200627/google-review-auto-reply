import { describe, expect, it } from "vitest";
import {
  FEATURE_MAP_DOCUMENTATION,
  featureEnabled,
  mapProductFeatureToStored,
} from "@/lib/entitlements/featureMap";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import { defaultPlanFields } from "@/lib/entitlements/plans";

describe("entitlement featureMap", () => {
  it("maps product concepts onto existing stored flags", () => {
    expect(mapProductFeatureToStored("orm")).toBe("reviewSync");
    expect(mapProductFeatureToStored("autoReply")).toBe("automation");
    expect(mapProductFeatureToStored("seo")).toBe("advancedAnalytics");
    expect(mapProductFeatureToStored("monthlyReport")).toBe("advancedAnalytics");
    expect(mapProductFeatureToStored("fakeReviewFlagging")).toBe(
      "advancedAnalytics"
    );
    expect(mapProductFeatureToStored("maxLocations")).toBe("maxLocations");
  });

  it("does not invent entitlements — reads stored flags only", () => {
    const starter = toPlanSnapshot(defaultPlanFields("starter"));
    expect(featureEnabled(starter, "seo")).toBe(
      Boolean(starter.features.advancedAnalytics)
    );
    expect(featureEnabled(starter, "autoReply")).toBe(
      Boolean(starter.features.automation)
    );
    expect(FEATURE_MAP_DOCUMENTATION.seo).toBe("advancedAnalytics");
  });

  it("fails closed when plan status is not operational", () => {
    const suspended = toPlanSnapshot({
      ...defaultPlanFields("starter"),
      status: "suspended",
      features: {
        reviewSync: true,
        aiDrafts: true,
        advancedAnalytics: true,
        automation: true,
      },
    });
    expect(featureEnabled(suspended, "seo")).toBe(false);
    expect(featureEnabled(suspended, "orm")).toBe(false);
  });
});
