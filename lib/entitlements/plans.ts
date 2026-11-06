/**
 * Central plan definitions and entitlement helpers.
 * Payments are out of scope — Super Admin assigns plans manually.
 */

export const PLAN_STATUSES = ["active", "suspended", "expired"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_CODES = ["free", "starter", "growth", "custom"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export type PlanFeatures = {
  reviewSync: boolean;
  aiDrafts: boolean;
  /** UI/metrics only in this build — no dedicated analytics product. */
  advancedAnalytics: boolean;
  /**
   * When true, Super Admin may explicitly enable Business.autoPublish.
   * replyMode=auto alone never authorizes publishing. Global kill switch
   * AUTO_PUBLISH_GLOBALLY_ENABLED must also be true.
   */
  automation: boolean;
};

export type PlanLimits = {
  /** Product rule remains ≤1 location; plans may only tighten further. */
  maxLocations: number;
  maxOwnerAccounts: number;
  /** Monthly AI draft quota. Use -1 for unlimited. */
  monthlyAiDraftQuota: number;
};

export type PlanDefinition = {
  code: PlanCode;
  displayName: string;
  features: PlanFeatures;
  limits: PlanLimits;
};

export const PLAN_CATALOG: Record<PlanCode, PlanDefinition> = {
  free: {
    code: "free",
    displayName: "Free",
    features: {
      reviewSync: true,
      aiDrafts: false,
      advancedAnalytics: false,
      automation: false,
    },
    limits: {
      maxLocations: 1,
      maxOwnerAccounts: 1,
      monthlyAiDraftQuota: 0,
    },
  },
  starter: {
    code: "starter",
    displayName: "Starter",
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
  },
  growth: {
    code: "growth",
    displayName: "Growth",
    features: {
      reviewSync: true,
      aiDrafts: true,
      advancedAnalytics: true,
      automation: false,
    },
    limits: {
      maxLocations: 1,
      maxOwnerAccounts: 2,
      monthlyAiDraftQuota: 500,
    },
  },
  custom: {
    code: "custom",
    displayName: "Custom",
    features: {
      reviewSync: true,
      aiDrafts: true,
      advancedAnalytics: true,
      /** Catalog default allows entitlement; still requires explicit enable + kill switch. */
      automation: true,
    },
    limits: {
      maxLocations: 1,
      maxOwnerAccounts: 5,
      monthlyAiDraftQuota: -1,
    },
  },
};

export type BusinessPlanSnapshot = {
  code: PlanCode;
  displayName: string;
  status: PlanStatus;
  features: PlanFeatures;
  limits: PlanLimits;
  usage: {
    aiDraftsThisPeriod: number;
    periodStart: string | null;
  };
  assignedAt: string | null;
  notes: string;
};

export function defaultPlanFields(code: PlanCode = "starter"): {
  code: PlanCode;
  displayName: string;
  status: PlanStatus;
  features: PlanFeatures;
  limits: PlanLimits;
  usage: { aiDraftsThisPeriod: number; periodStart: Date };
  assignedAt: Date;
  notes: string;
} {
  const def = PLAN_CATALOG[code];
  return {
    code: def.code,
    displayName: def.displayName,
    status: "active",
    features: { ...def.features },
    limits: { ...def.limits },
    usage: { aiDraftsThisPeriod: 0, periodStart: new Date() },
    assignedAt: new Date(),
    notes: "",
  };
}

export function isPlanCode(value: unknown): value is PlanCode {
  return (
    typeof value === "string" &&
    (PLAN_CODES as readonly string[]).includes(value)
  );
}

export function isPlanStatus(value: unknown): value is PlanStatus {
  return (
    typeof value === "string" &&
    (PLAN_STATUSES as readonly string[]).includes(value)
  );
}

/** Deny policy: suspended and expired block all limited features. */
export function planAllowsOperations(status: PlanStatus | string | undefined): boolean {
  return status === "active";
}
