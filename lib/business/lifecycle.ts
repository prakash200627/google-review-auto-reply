/**
 * Business lifecycle status with compatibility for legacy `Business.active`.
 *
 * Existing documents without `status`:
 * - active === true  → "active"
 * - active === false → "suspended" (never inferred as archived)
 */

export const BUSINESS_LIFECYCLE_STATUSES = [
  "active",
  "suspended",
  "archived",
] as const;

export type BusinessLifecycleStatus =
  (typeof BUSINESS_LIFECYCLE_STATUSES)[number];

export type LifecycleTransition =
  | "suspend"
  | "reactivate"
  | "archive"
  | "restore";

export type BusinessLifecycleFields = {
  status?: string | null;
  active?: boolean | null;
  autoPublish?: {
    enabled?: boolean | null;
    disabledByAdmin?: boolean | null;
  } | null;
};

/** Resolve authoritative lifecycle from status, falling back to legacy active. */
export function resolveBusinessLifecycle(
  business: BusinessLifecycleFields | null | undefined
): BusinessLifecycleStatus {
  const raw = String(business?.status || "").trim().toLowerCase();
  if (raw === "active" || raw === "suspended" || raw === "archived") {
    return raw;
  }
  // Missing status: never treat inactive as archived.
  return business?.active === false ? "suspended" : "active";
}

export function isBusinessOperationallyActive(
  business: BusinessLifecycleFields | null | undefined
): boolean {
  return resolveBusinessLifecycle(business) === "active";
}

export function lifecycleAllowsOwnerAccess(
  business: BusinessLifecycleFields | null | undefined
): boolean {
  return isBusinessOperationallyActive(business);
}

export function lifecycleAllowsSync(
  business: BusinessLifecycleFields | null | undefined
): boolean {
  return isBusinessOperationallyActive(business);
}

export function lifecycleAllowsDraft(
  business: BusinessLifecycleFields | null | undefined
): boolean {
  return isBusinessOperationallyActive(business);
}

export function lifecycleAllowsPublish(
  business: BusinessLifecycleFields | null | undefined
): boolean {
  return isBusinessOperationallyActive(business);
}

export function lifecycleAllowsAutoPublish(
  business: BusinessLifecycleFields | null | undefined
): boolean {
  return isBusinessOperationallyActive(business);
}

export function isLifecycleStatus(value: unknown): value is BusinessLifecycleStatus {
  return (
    typeof value === "string" &&
    (BUSINESS_LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

/** Valid next statuses for UI/API transition actions. */
export function allowedLifecycleTransitions(
  current: BusinessLifecycleStatus
): LifecycleTransition[] {
  switch (current) {
    case "active":
      return ["suspend", "archive"];
    case "suspended":
      return ["reactivate", "archive"];
    case "archived":
      return ["restore"];
    default:
      return [];
  }
}

export function applyLifecycleTransition(
  current: BusinessLifecycleStatus,
  action: LifecycleTransition
): {
  status: BusinessLifecycleStatus;
  active: boolean;
  /** When true, callers must disable auto-publish and require explicit re-enable. */
  disableAutoReply: boolean;
} {
  const allowed = allowedLifecycleTransitions(current);
  if (!allowed.includes(action)) {
    throw new LifecycleTransitionError(
      `Cannot ${action} a business in status "${current}".`,
      { code: "invalid_transition", from: current, action }
    );
  }

  if (action === "suspend") {
    // Disarm automation; Reactivate must not re-enable — SA re-enable required.
    return { status: "suspended", active: false, disableAutoReply: true };
  }
  if (action === "archive") {
    return { status: "archived", active: false, disableAutoReply: true };
  }
  if (action === "restore") {
    // Archived → Suspended only; never auto-enable reply automation.
    return { status: "suspended", active: false, disableAutoReply: true };
  }
  // reactivate: Suspended → Active — keep auto-reply disabled (disableAutoReply true
  // means callers must leave / keep automation off; SA must re-enable explicitly).
  return { status: "active", active: true, disableAutoReply: true };
}

export class LifecycleTransitionError extends Error {
  code: string;
  from: BusinessLifecycleStatus;
  action: LifecycleTransition;

  constructor(
    message: string,
    input: {
      code: string;
      from: BusinessLifecycleStatus;
      action: LifecycleTransition;
    }
  ) {
    super(message);
    this.name = "LifecycleTransitionError";
    this.code = input.code;
    this.from = input.from;
    this.action = input.action;
  }
}

/** Dual-write payload for lifecycle changes (status + legacy active). */
export function lifecycleWriteFields(status: BusinessLifecycleStatus): {
  status: BusinessLifecycleStatus;
  active: boolean;
} {
  return {
    status,
    active: status === "active",
  };
}
