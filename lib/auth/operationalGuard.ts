import { NextResponse } from "next/server";
import {
  resolveBusinessLifecycle,
  lifecycleAllowsDraft,
  lifecycleAllowsPublish,
  lifecycleAllowsSync,
  lifecycleAllowsAutoPublish,
  type BusinessLifecycleFields,
} from "@/lib/business/lifecycle";
import {
  assertFeatureEnabled,
  EntitlementError,
  loadBusinessPlan,
  toPlanSnapshot,
} from "@/lib/entitlements/enforce";
import type { PlanFeatures } from "@/lib/entitlements/plans";
import { featureEnabled } from "@/lib/entitlements/featureMap";

export type OperationalAction =
  | "sync"
  | "draft"
  | "publish"
  | "auto_publish"
  | "read_reports"
  | "read_seo"
  | "manage_seo"
  | "read_services"
  | "manage_services"
  | "read_billing";

export class OperationalGuardError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "OperationalGuardError";
    this.code = code;
    this.status = status;
  }
}

export function operationalGuardResponse(err: OperationalGuardError): NextResponse {
  return NextResponse.json(
    { success: false, code: err.code, message: err.message },
    { status: err.status }
  );
}

/**
 * Lifecycle gate for business-scoped operations.
 * Super Admin support still must pass this before external publishing/sync/draft
 * unless explicitly overridden for read-only support (not for writes).
 */
export function assertLifecycleAllowsAction(
  business: BusinessLifecycleFields,
  action: OperationalAction
): void {
  const status = resolveBusinessLifecycle(business);
  // Staff manage SEO/GMB may continue while a business is suspended/archived
  // (e.g. suspension_assistance jobs). Owner reads still require active.
  const ok =
    action === "manage_seo" || action === "manage_services"
      ? true
      : action === "sync"
        ? lifecycleAllowsSync(business)
        : action === "draft"
          ? lifecycleAllowsDraft(business)
          : action === "publish" || action === "auto_publish"
            ? action === "auto_publish"
              ? lifecycleAllowsAutoPublish(business)
              : lifecycleAllowsPublish(business)
            : // reports/seo/services/billing reads: owners need active business
              lifecycleAllowsDraft(business);

  if (!ok) {
    throw new OperationalGuardError(
      `Business is ${status}. This operation is not available until a Super Admin restores and reactivates the business.`,
      { code: "business_lifecycle_blocked", status: 403 }
    );
  }
}

/** Map product feature concepts onto stored plan feature flags. */
export function requiredPlanFeatureForAction(
  action: OperationalAction
): keyof PlanFeatures | null {
  switch (action) {
    case "sync":
      return "reviewSync";
    case "draft":
      return "aiDrafts";
    case "auto_publish":
      return "automation";
    case "read_reports":
    case "read_seo":
    case "manage_seo":
    case "read_services":
    case "manage_services":
      return "advancedAnalytics"; // mapped; see featureMap for seo/report aliases
    case "publish":
    case "read_billing":
      return null;
    default:
      return null;
  }
}

/**
 * Full operational check for a known business document + plan.
 * Does not replace tenant ownership checks — call after assertBusinessAccess.
 */
export async function assertBusinessOperationAllowed(input: {
  businessId: string;
  business: BusinessLifecycleFields;
  action: OperationalAction;
  /** When true, skip plan feature gate (not lifecycle). Rare; prefer false. */
  skipPlanFeature?: boolean;
  /**
   * Super Admin staff management (manage_seo / manage_services) skips customer
   * plan entitlement checks. Owner reads remain entitlement-gated.
   */
  actorRole?: string | null;
}): Promise<void> {
  const isStaffSeoOrServices =
    input.actorRole === "superadmin" &&
    (input.action === "manage_seo" ||
      input.action === "manage_services" ||
      input.action === "read_seo" ||
      input.action === "read_services");

  // SA staff SEO/GMB reads use manage lifecycle rules (allowed while suspended).
  const lifecycleAction: OperationalAction =
    input.actorRole === "superadmin" && input.action === "read_seo"
      ? "manage_seo"
      : input.actorRole === "superadmin" && input.action === "read_services"
        ? "manage_services"
        : input.action;
  assertLifecycleAllowsAction(input.business, lifecycleAction);

  if (input.skipPlanFeature) return;

  if (isStaffSeoOrServices) {
    // Tenant + lifecycle already enforced; do not block internal support work
    // on customer advancedAnalytics flags.
    return;
  }

  const feature = requiredPlanFeatureForAction(input.action);
  if (!feature) return;

  // Prefer mapped conceptual checks for report/seo when action is specialized.
  if (
    input.action === "read_seo" ||
    input.action === "manage_seo" ||
    input.action === "read_reports"
  ) {
    const { plan } = await loadBusinessPlan(input.businessId);
    if (!featureEnabled(plan, input.action === "read_reports" ? "monthlyReport" : "seo")) {
      throw new OperationalGuardError(
        `Feature is not included in the ${plan.displayName} plan.`,
        { code: "feature_disabled", status: 403 }
      );
    }
    return;
  }

  if (input.action === "auto_publish") {
    const { plan } = await loadBusinessPlan(input.businessId);
    if (!featureEnabled(plan, "autoReply") && !plan.features.automation) {
      throw new OperationalGuardError(
        "Automatic reply entitlement is not included in this plan.",
        { code: "feature_disabled", status: 403 }
      );
    }
    assertFeatureEnabled(plan, "automation");
    return;
  }

  const { plan } = await loadBusinessPlan(input.businessId);
  assertFeatureEnabled(plan, feature);
}

export function toGuardError(
  err: unknown
): OperationalGuardError | EntitlementError | null {
  if (err instanceof OperationalGuardError) return err;
  if (err instanceof EntitlementError) return err;
  return null;
}

/** Snapshot helper for APIs returning lifecycle to clients. */
export function lifecycleSnapshot(business: BusinessLifecycleFields) {
  const status = resolveBusinessLifecycle(business);
  return {
    status,
    active: status === "active",
    legacyActive: Boolean(business.active),
    planSnapshotHint: toPlanSnapshot,
  };
}
