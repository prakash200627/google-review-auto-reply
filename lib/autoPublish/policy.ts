import {
  planAllowsOperations,
  type PlanFeatures,
  type PlanStatus,
} from "@/lib/entitlements/plans";

export type AutoPublishConfig = {
  enabled: boolean;
  /** Minutes between review sync attempts for auto-publish pipeline. */
  syncIntervalMinutes: number;
  /** Delay after draft before eligible publish. */
  publishDelayMinutes: number;
  /**
   * Reviews at or below this star rating require human approval
   * (never auto-published).
   */
  maxAutoStarRatingExclusive: number;
  /** Per-business emergency disable (independent of replyMode). */
  disabledByAdmin: boolean;
};

export const DEFAULT_AUTO_PUBLISH_CONFIG: AutoPublishConfig = {
  enabled: false,
  syncIntervalMinutes: 60,
  publishDelayMinutes: 15,
  /** Ratings strictly below this require manual approval (default: 1–2★). */
  maxAutoStarRatingExclusive: 3,
  disabledByAdmin: false,
};

/** High-risk phrases — fail closed to manual handling. */
export const AUTO_PUBLISH_RISK_PHRASES = [
  "lawyer",
  "attorney",
  "sue",
  "lawsuit",
  "legal action",
  "health department",
  "food poison",
  "foodborne",
  "police",
  "assault",
  "harass",
  "unsafe",
  "danger",
  "hospital",
  "ambulance",
  "racist",
  "discrimination",
] as const;

export const AUTO_PUBLISH_LIMITS = {
  syncIntervalMinutes: { min: 15, max: 24 * 60 },
  publishDelayMinutes: { min: 5, max: 24 * 60 },
  maxAutoStarRatingExclusive: { min: 1, max: 6 },
} as const;

/** Global emergency kill switch — must be explicitly enabled in env. */
export function isAutoPublishGloballyEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return String(env.AUTO_PUBLISH_GLOBALLY_ENABLED || "").trim() === "true";
}

export function normalizeAutoPublishConfig(
  raw: Partial<AutoPublishConfig> | null | undefined
): AutoPublishConfig {
  const base = { ...DEFAULT_AUTO_PUBLISH_CONFIG, ...(raw || {}) };
  const clamp = (n: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.floor(n)));

  return {
    enabled: Boolean(base.enabled),
    syncIntervalMinutes: clamp(
      Number(base.syncIntervalMinutes) || DEFAULT_AUTO_PUBLISH_CONFIG.syncIntervalMinutes,
      AUTO_PUBLISH_LIMITS.syncIntervalMinutes.min,
      AUTO_PUBLISH_LIMITS.syncIntervalMinutes.max
    ),
    publishDelayMinutes: clamp(
      Number(base.publishDelayMinutes) || DEFAULT_AUTO_PUBLISH_CONFIG.publishDelayMinutes,
      AUTO_PUBLISH_LIMITS.publishDelayMinutes.min,
      AUTO_PUBLISH_LIMITS.publishDelayMinutes.max
    ),
    maxAutoStarRatingExclusive: clamp(
      Number(base.maxAutoStarRatingExclusive) ||
        DEFAULT_AUTO_PUBLISH_CONFIG.maxAutoStarRatingExclusive,
      AUTO_PUBLISH_LIMITS.maxAutoStarRatingExclusive.min,
      AUTO_PUBLISH_LIMITS.maxAutoStarRatingExclusive.max
    ),
    disabledByAdmin: Boolean(base.disabledByAdmin),
  };
}

/**
 * replyMode === "auto" alone NEVER authorizes publishing.
 * Requires: global kill switch, per-business enable, plan automation feature,
 * active plan, and not disabledByAdmin.
 */
export function assertAutoPublishAuthorized(input: {
  replyMode?: string;
  autoPublish: AutoPublishConfig;
  planStatus: PlanStatus | string;
  planFeatures: PlanFeatures;
  globallyEnabled?: boolean;
}): void {
  if (!(input.globallyEnabled ?? isAutoPublishGloballyEnabled())) {
    throw new AutoPublishPolicyError(
      "Automatic publishing is globally disabled. Set AUTO_PUBLISH_GLOBALLY_ENABLED=true only when explicitly authorized.",
      { code: "global_kill_switch" }
    );
  }
  if (!planAllowsOperations(input.planStatus)) {
    throw new AutoPublishPolicyError(
      `Subscription is ${input.planStatus}; automatic publishing is unavailable.`,
      { code: "plan_inactive" }
    );
  }
  if (!input.planFeatures.automation) {
    throw new AutoPublishPolicyError(
      "Plan does not include the automation entitlement.",
      { code: "feature_disabled" }
    );
  }
  if (input.autoPublish.disabledByAdmin || !input.autoPublish.enabled) {
    throw new AutoPublishPolicyError(
      "Automatic publishing is not enabled for this business.",
      { code: "business_disabled" }
    );
  }
  // Explicitly ignore replyMode for authorization decisions.
  void input.replyMode;
}

export class AutoPublishPolicyError extends Error {
  code: string;
  constructor(message: string, { code }: { code: string }) {
    super(message);
    this.name = "AutoPublishPolicyError";
    this.code = code;
  }
}

/**
 * Risk gate: uncertain/low ratings go to human approval.
 * Missing star rating is treated as uncertain → awaiting_approval.
 */
export function classifyAutoPublishRisk(input: {
  starRating: number | null | undefined;
  maxAutoStarRatingExclusive: number;
  comment?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (typeof input.starRating !== "number") {
    return { ok: false, reason: "missing_star_rating" };
  }
  // Product default: 1★ and 2★ always require manual handling.
  if (input.starRating <= 2) {
    return { ok: false, reason: "low_star_manual_required" };
  }
  if (input.starRating < input.maxAutoStarRatingExclusive) {
    return {
      ok: false,
      reason: `star_rating_below_threshold_${input.maxAutoStarRatingExclusive}`,
    };
  }
  const comment = String(input.comment || "").toLowerCase();
  for (const phrase of AUTO_PUBLISH_RISK_PHRASES) {
    if (comment.includes(phrase)) {
      return { ok: false, reason: `sensitive_language_${phrase.replace(/\s+/g, "_")}` };
    }
  }
  return { ok: true };
}
