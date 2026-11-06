/**
 * Structured audit logging: stdout JSON lines + durable Mongo AuditEvent.
 * Persistence is best-effort with failure visibility:
 * - in-process counter (tests / single instance)
 * - durable AuditPersistHealth document (cross-instance alerting signal)
 * - stderr structured lines (NOT durable storage — ops must scrape or alert on them)
 *
 * Never logs passwords, tokens, encryption keys, or review body text.
 * Never calls auditLog when persistence itself fails (no recursion).
 */

import mongoose from "mongoose";

export type AuditActor = {
  actorId: string | null;
  actorRole: string | null;
};

export type AuditEventPayload = AuditActor & {
  action: string;
  success: boolean;
  /** Non-sensitive resource identifiers only (ids, emails of accounts, codes). */
  target?: Record<string, string | number | boolean | null | undefined>;
  code?: string;
};

const FORBIDDEN_KEY =
  /password|token|secret|cipher|refresh|authorization|cookie|hash|draftText|comment|reply/i;

/** Default alert threshold when AUDIT_PERSIST_FAILURE_ALERT_THRESHOLD is unset. */
export const DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD = 5;

/** In-process counter for durable persist failures (visible to ops/tests). */
let durablePersistFailures = 0;

export function getAuditPersistFailureCount(): number {
  return durablePersistFailures;
}

export function resetAuditPersistFailureCountForTests(): void {
  durablePersistFailures = 0;
}

export function getAuditPersistAlertThreshold(
  env: NodeJS.Dict<string> = process.env
): number {
  const raw = (env.AUDIT_PERSIST_FAILURE_ALERT_THRESHOLD || "").trim();
  if (!raw) return DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD;
  return Math.floor(n);
}

function sanitizeTarget(
  target: AuditEventPayload["target"]
): Record<string, string | number | boolean | null> | undefined {
  if (!target) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(target)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 200) {
      out[key] = `${value.slice(0, 200)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function extractScopedIds(target: Record<string, string | number | boolean | null> | undefined) {
  const orgId =
    target && typeof target.orgId === "string" && mongoose.isValidObjectId(target.orgId)
      ? target.orgId
      : null;
  const businessId =
    target &&
    typeof target.businessId === "string" &&
    mongoose.isValidObjectId(target.businessId)
      ? target.businessId
      : null;
  return { orgId, businessId };
}

/**
 * Emit one audit line and attempt durable persistence.
 * Never throws — callers must not treat logging as part of business success.
 */
export function auditLog(event: AuditEventPayload): void {
  try {
    const at = new Date();
    const target = sanitizeTarget(event.target);
    const line = {
      type: "audit" as const,
      at: at.toISOString(),
      actorId: event.actorId || null,
      actorRole: event.actorRole || null,
      action: String(event.action || "unknown"),
      success: Boolean(event.success),
      ...(event.code ? { code: String(event.code) } : {}),
      ...(target ? { target } : {}),
    };
    console.info(JSON.stringify(line));

    void persistAuditEvent({
      at,
      actorId: event.actorId,
      actorRole: event.actorRole,
      action: line.action,
      success: line.success,
      code: event.code || "",
      target: target || {},
    });
  } catch {
    // swallow — audit must not break request handling
  }
}

/**
 * Record a persistence failure to the durable health doc + stderr alert.
 * Must never call auditLog.
 */
export async function recordAuditPersistFailure(input: {
  action: string;
  errorMessage: string;
  /** Injectable for tests. */
  threshold?: number;
  now?: Date;
}): Promise<{ failureCount: number; alertFired: boolean }> {
  durablePersistFailures += 1;
  const failureCount = durablePersistFailures;
  const threshold = input.threshold ?? getAuditPersistAlertThreshold();
  const now = input.now ?? new Date();
  const safeError = String(input.errorMessage || "unknown").slice(0, 120);
  const safeAction = String(input.action || "unknown").slice(0, 64);

  // Stderr signal (not durable). Suitable for log scrapers.
  console.error(
    JSON.stringify({
      type: "audit_persist_failure",
      at: now.toISOString(),
      action: safeAction,
      failureCount,
      threshold,
      error: safeError,
      note: "stdout/stderr is not durable audit storage",
    })
  );

  let alertFired = false;
  try {
    const { connectToDatabase } = await import("@/lib/mongodb");
    const {
      AuditPersistHealth,
      AUDIT_PERSIST_HEALTH_ID,
    } = await import("@/models/AuditPersistHealth");
    await connectToDatabase();

    const crossed = failureCount >= threshold;
    const updated = await AuditPersistHealth.findOneAndUpdate(
      { _id: AUDIT_PERSIST_HEALTH_ID },
      {
        $inc: { failureCount: 1 },
        $set: {
          lastFailureAt: now,
          lastErrorCode: "persist_failed",
          lastAction: safeAction,
          ...(crossed
            ? { alertArmed: true, lastAlertAt: now }
            : {}),
        },
        $setOnInsert: { _id: AUDIT_PERSIST_HEALTH_ID },
      },
      { upsert: true, returnDocument: "after" }
    ).lean();

    if (crossed) {
      alertFired = true;
      // Dedicated alert line — never routed through auditLog.
      console.error(
        JSON.stringify({
          type: "audit_persist_alert",
          at: now.toISOString(),
          failureCount: updated?.failureCount ?? failureCount,
          threshold,
          lastAction: safeAction,
          message:
            "Audit Mongo persistence failures exceeded alert threshold. Investigate DB connectivity and AuditEvent writes. Do not treat stdout as the durable audit log.",
        })
      );
    }
  } catch {
    // Health doc write failed too — stderr above is the remaining signal.
    if (failureCount >= threshold) {
      alertFired = true;
      console.error(
        JSON.stringify({
          type: "audit_persist_alert",
          at: now.toISOString(),
          failureCount,
          threshold,
          lastAction: safeAction,
          healthWriteFailed: true,
          message:
            "Audit persistence and health-doc write both failed. Check MongoDB availability.",
        })
      );
    }
  }

  return { failureCount, alertFired };
}

async function persistAuditEvent(input: {
  at: Date;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  success: boolean;
  code: string;
  target: Record<string, string | number | boolean | null>;
}): Promise<void> {
  try {
    const { connectToDatabase } = await import("@/lib/mongodb");
    const { AuditEvent } = await import("@/models/AuditEvent");
    await connectToDatabase();
    const { orgId, businessId } = extractScopedIds(input.target);
    await AuditEvent.create({
      at: input.at,
      actorId:
        input.actorId && mongoose.isValidObjectId(input.actorId)
          ? input.actorId
          : null,
      actorRole: input.actorRole,
      action: input.action,
      success: input.success,
      code: input.code,
      orgId,
      businessId,
      target: input.target,
    });
  } catch (err) {
    await recordAuditPersistFailure({
      action: input.action,
      errorMessage: err instanceof Error ? err.message : "unknown",
    });
  }
}
