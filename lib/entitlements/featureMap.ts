/**
 * Backwards-compatible mapping from product feature concepts to stored plan flags.
 *
 * Stored flags (existing):
 * - reviewSync, aiDrafts, advancedAnalytics, automation
 *
 * Product concepts (future-facing aliases; not separate DB columns yet):
 * - orm → reviewSync (online reputation management core)
 * - monthlyReport → advancedAnalytics
 * - autoReply → automation
 * - fakeReviewFlagging → advancedAnalytics
 * - seo → advancedAnalytics
 * - maxLocations → plan.limits.maxLocations
 *
 * New concepts are NOT auto-granted to every plan: they follow the mapped
 * stored flag already assigned on the business.
 */

import type { BusinessPlanSnapshot, PlanFeatures } from "@/lib/entitlements/plans";
import { planAllowsOperations } from "@/lib/entitlements/plans";

export type ProductFeature =
  | "orm"
  | "monthlyReport"
  | "autoReply"
  | "fakeReviewFlagging"
  | "seo"
  | "maxLocations"
  | "reviewSync"
  | "aiDrafts"
  | "advancedAnalytics"
  | "automation";

export function mapProductFeatureToStored(
  feature: ProductFeature
): keyof PlanFeatures | "maxLocations" {
  switch (feature) {
    case "orm":
    case "reviewSync":
      return "reviewSync";
    case "aiDrafts":
      return "aiDrafts";
    case "autoReply":
    case "automation":
      return "automation";
    case "monthlyReport":
    case "fakeReviewFlagging":
    case "seo":
    case "advancedAnalytics":
      return "advancedAnalytics";
    case "maxLocations":
      return "maxLocations";
    default:
      return "reviewSync";
  }
}

type FeaturePlanView = {
  status: BusinessPlanSnapshot["status"] | string;
  features: PlanFeatures;
  limits: BusinessPlanSnapshot["limits"];
};

export function featureEnabled(
  plan: FeaturePlanView,
  feature: ProductFeature
): boolean {
  if (!planAllowsOperations(plan.status)) return false;
  const mapped = mapProductFeatureToStored(feature);
  if (mapped === "maxLocations") {
    return plan.limits.maxLocations > 0;
  }
  return Boolean(plan.features[mapped]);
}

export const FEATURE_MAP_DOCUMENTATION = {
  orm: "reviewSync",
  monthlyReport: "advancedAnalytics",
  autoReply: "automation",
  fakeReviewFlagging: "advancedAnalytics",
  seo: "advancedAnalytics",
  maxLocations: "plan.limits.maxLocations",
  note: "Aliases do not invent new entitlements; they read existing stored flags.",
} as const;
