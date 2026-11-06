import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

/** Minimum entropy for AUTO_PUBLISH_SCHEDULER_SECRET (characters). */
export const SCHEDULER_SECRET_MIN_LENGTH = 32;

/**
 * Authenticate internal scheduler/worker callers via dedicated header only.
 * Never accepts Super Admin session as a substitute for live publishing.
 * Never logs the secret value.
 */
export function assertSchedulerSecret(
  request: Request
): { ok: true } | { ok: false; response: NextResponse } {
  const expected = String(
    process.env.AUTO_PUBLISH_SCHEDULER_SECRET || ""
  ).trim();
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "scheduler_not_configured",
          message:
            "Scheduler secret is not configured. Set AUTO_PUBLISH_SCHEDULER_SECRET (min 32 chars) for worker calls.",
        },
        { status: 503 }
      ),
    };
  }

  if (expected.length < SCHEDULER_SECRET_MIN_LENGTH) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "scheduler_secret_weak",
          message:
            "AUTO_PUBLISH_SCHEDULER_SECRET is too short. Use at least 32 characters.",
        },
        { status: 503 }
      ),
    };
  }

  // Dedicated header only — do not accept Authorization Bearer (ambiguous).
  const header = String(
    request.headers.get("x-tronx-scheduler-secret") || ""
  ).trim();

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "unauthorized",
          message: "Invalid scheduler credentials.",
        },
        { status: 401 }
      ),
    };
  }

  return { ok: true };
}
