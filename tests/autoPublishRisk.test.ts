import { describe, expect, it } from "vitest";
import {
  AUTO_PUBLISH_RISK_PHRASES,
  DEFAULT_AUTO_PUBLISH_CONFIG,
  classifyAutoPublishRisk,
  isAutoPublishGloballyEnabled,
} from "@/lib/autoPublish/policy";

describe("auto-publish safety", () => {
  it("keeps global kill switch off by default", () => {
    expect(isAutoPublishGloballyEnabled({})).toBe(false);
    expect(
      isAutoPublishGloballyEnabled({ AUTO_PUBLISH_GLOBALLY_ENABLED: "true" })
    ).toBe(true);
  });

  it("requires manual handling for 1★ and 2★", () => {
    expect(
      classifyAutoPublishRisk({
        starRating: 1,
        maxAutoStarRatingExclusive:
          DEFAULT_AUTO_PUBLISH_CONFIG.maxAutoStarRatingExclusive,
        comment: "ok",
      })
    ).toMatchObject({ ok: false, reason: "low_star_manual_required" });
    expect(
      classifyAutoPublishRisk({
        starRating: 2,
        maxAutoStarRatingExclusive:
          DEFAULT_AUTO_PUBLISH_CONFIG.maxAutoStarRatingExclusive,
        comment: "ok",
      })
    ).toMatchObject({ ok: false, reason: "low_star_manual_required" });
  });

  it("fails closed on missing rating", () => {
    expect(
      classifyAutoPublishRisk({
        starRating: null,
        maxAutoStarRatingExclusive:
          DEFAULT_AUTO_PUBLISH_CONFIG.maxAutoStarRatingExclusive,
        comment: "Nice place",
      })
    ).toMatchObject({ ok: false, reason: "missing_star_rating" });
  });

  it("flags high-risk phrases for manual handling", () => {
    expect(AUTO_PUBLISH_RISK_PHRASES).toContain("food poison");
    expect(AUTO_PUBLISH_RISK_PHRASES).toContain("lawyer");
    const result = classifyAutoPublishRisk({
      starRating: 5,
      maxAutoStarRatingExclusive:
        DEFAULT_AUTO_PUBLISH_CONFIG.maxAutoStarRatingExclusive,
      comment: "Calling my lawyer about food poison",
    });
    expect(result.ok).toBe(false);
  });
});
