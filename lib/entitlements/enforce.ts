import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import {
  planAllowsOperations,
  type BusinessPlanSnapshot,
  type PlanCode,
  type PlanFeatures,
  type PlanLimits,
  type PlanStatus,
  PLAN_CATALOG,
} from "@/lib/entitlements/plans";

export class EntitlementError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "EntitlementError";
    this.code = code;
    this.status = status;
  }
}

export function entitlementErrorResponse(err: EntitlementError): NextResponse {
  return NextResponse.json(
    { success: false, code: err.code, message: err.message },
    { status: err.status }
  );
}

type PlanDoc = {
  code?: string;
  displayName?: string;
  status?: string;
  features?: Partial<PlanFeatures>;
  limits?: Partial<PlanLimits>;
  usage?: { aiDraftsThisPeriod?: number; periodStart?: Date | null };
  assignedAt?: Date | null;
  notes?: string;
};

function normalizePlan(raw: PlanDoc | null | undefined): {
  code: PlanCode;
  displayName: string;
  status: PlanStatus;
  features: PlanFeatures;
  limits: PlanLimits;
  usage: { aiDraftsThisPeriod: number; periodStart: Date | null };
  assignedAt: Date | null;
  notes: string;
} {
  const code =
    raw?.code && raw.code in PLAN_CATALOG
      ? (raw.code as PlanCode)
      : "starter";
  const catalog = PLAN_CATALOG[code];
  const status: PlanStatus =
    raw?.status === "suspended" || raw?.status === "expired"
      ? raw.status
      : "active";

  return {
    code,
    displayName: raw?.displayName || catalog.displayName,
    status,
    features: {
      reviewSync: raw?.features?.reviewSync ?? catalog.features.reviewSync,
      aiDrafts: raw?.features?.aiDrafts ?? catalog.features.aiDrafts,
      advancedAnalytics:
        raw?.features?.advancedAnalytics ?? catalog.features.advancedAnalytics,
      automation: raw?.features?.automation ?? catalog.features.automation,
    },
    limits: {
      maxLocations: Math.min(
        1,
        Math.max(0, raw?.limits?.maxLocations ?? catalog.limits.maxLocations)
      ),
      maxOwnerAccounts: Math.max(
        0,
        raw?.limits?.maxOwnerAccounts ?? catalog.limits.maxOwnerAccounts
      ),
      monthlyAiDraftQuota:
        raw?.limits?.monthlyAiDraftQuota ?? catalog.limits.monthlyAiDraftQuota,
    },
    usage: {
      aiDraftsThisPeriod: Math.max(0, raw?.usage?.aiDraftsThisPeriod ?? 0),
      periodStart: raw?.usage?.periodStart
        ? new Date(raw.usage.periodStart)
        : null,
    },
    assignedAt: raw?.assignedAt ? new Date(raw.assignedAt) : null,
    notes: raw?.notes || "",
  };
}

export function toPlanSnapshot(raw: PlanDoc | null | undefined): BusinessPlanSnapshot {
  const plan = normalizePlan(raw);
  return {
    code: plan.code,
    displayName: plan.displayName,
    status: plan.status,
    features: plan.features,
    limits: plan.limits,
    usage: {
      aiDraftsThisPeriod: plan.usage.aiDraftsThisPeriod,
      periodStart: plan.usage.periodStart
        ? plan.usage.periodStart.toISOString()
        : null,
    },
    assignedAt: plan.assignedAt ? plan.assignedAt.toISOString() : null,
    notes: plan.notes,
  };
}

function sameMonth(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth()
  );
}

/**
 * Load and authorize a business plan. Does not trust client plan claims.
 */
export async function loadBusinessPlan(businessId: string): Promise<{
  businessId: string;
  plan: ReturnType<typeof normalizePlan>;
}> {
  if (!mongoose.isValidObjectId(businessId)) {
    throw new EntitlementError("Invalid business id.", {
      code: "invalid_id",
      status: 400,
    });
  }
  await connectToDatabase();
  const business = await Business.findById(businessId)
    .select("plan active")
    .lean();
  if (!business) {
    throw new EntitlementError("Business not found.", {
      code: "not_found",
      status: 404,
    });
  }
  return {
    businessId: String(business._id),
    plan: normalizePlan(business.plan as PlanDoc | undefined),
  };
}

export function assertFeatureEnabled(
  plan: ReturnType<typeof normalizePlan>,
  feature: keyof PlanFeatures
): void {
  if (!planAllowsOperations(plan.status)) {
    throw new EntitlementError(
      `Subscription is ${plan.status}. Limited features are unavailable until a Super Admin reactivates the plan.`,
      { code: "plan_inactive", status: 403 }
    );
  }
  if (!plan.features[feature]) {
    throw new EntitlementError(
      `Feature "${feature}" is not included in the ${plan.displayName} plan.`,
      { code: "feature_disabled", status: 403 }
    );
  }
}

/**
 * Reserve one AI draft quota unit only when under limit.
 * Uses a conditional update so concurrent requests cannot both succeed.
 * Callers must not call this when the draft generation already failed —
 * reserve after success, or use tryReserve then rollback on failure.
 *
 * Policy used here: tryReserve before the operation; if the operation fails,
 * releaseReservation so failed ops do not consume quota.
 */
export async function tryReserveAiDraftQuota(businessId: string): Promise<void> {
  const { plan } = await loadBusinessPlan(businessId);
  assertFeatureEnabled(plan, "aiDrafts");

  const quota = plan.limits.monthlyAiDraftQuota;
  if (quota === 0) {
    throw new EntitlementError(
      "AI draft quota is zero for this plan.",
      { code: "quota_exhausted", status: 403 }
    );
  }

  await connectToDatabase();
  const now = new Date();
  const periodStart = plan.usage.periodStart;
  const needsRollover = !periodStart || !sameMonth(periodStart, now);

  if (needsRollover) {
    const updated = await Business.findOneAndUpdate(
      { _id: businessId },
      {
        $set: {
          "plan.usage.aiDraftsThisPeriod": 1,
          "plan.usage.periodStart": now,
        },
      },
      { returnDocument: "after" }
    )
      .select("plan")
      .lean();
    if (!updated) {
      throw new EntitlementError("Business not found.", {
        code: "not_found",
        status: 404,
      });
    }
    return;
  }

  if (quota < 0) {
    // Unlimited — still bump counter for observability.
    await Business.updateOne(
      { _id: businessId },
      { $inc: { "plan.usage.aiDraftsThisPeriod": 1 } }
    );
    return;
  }

  const reserved = await Business.findOneAndUpdate(
    {
      _id: businessId,
      "plan.usage.aiDraftsThisPeriod": { $lt: quota },
    },
    { $inc: { "plan.usage.aiDraftsThisPeriod": 1 } },
    { returnDocument: "after" }
  )
    .select("_id")
    .lean();

  if (!reserved) {
    throw new EntitlementError(
      "Monthly AI draft quota exhausted for this plan.",
      { code: "quota_exhausted", status: 403 }
    );
  }
}

/** Roll back a reserved draft unit after a failed generation. */
export async function releaseAiDraftQuota(businessId: string): Promise<void> {
  if (!mongoose.isValidObjectId(businessId)) return;
  await connectToDatabase();
  await Business.updateOne(
    {
      _id: businessId,
      "plan.usage.aiDraftsThisPeriod": { $gt: 0 },
    },
    { $inc: { "plan.usage.aiDraftsThisPeriod": -1 } }
  );
}

export async function assertReviewSyncAllowed(businessId: string): Promise<void> {
  const { plan } = await loadBusinessPlan(businessId);
  assertFeatureEnabled(plan, "reviewSync");
}
