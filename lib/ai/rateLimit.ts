/**
 * Simple in-memory per-org throttle for draft generation.
 * Resets on process restart — sufficient for local / single-instance use.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;

/** Unassigned SA drafts: stricter hourly cap to prevent unbounded OpenAI cost. */
const SA_UNASSIGNED_WINDOW_MS = 60 * 60_000;
const SA_UNASSIGNED_MAX = 5;

const hits = new Map<string, number[]>();

function checkBucket(
  key: string,
  windowMs: number,
  max: number,
  now: number
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const prior = hits.get(key) || [];
  const recent = prior.filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    const oldest = recent[0] ?? now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowMs - (now - oldest)) / 1000)
    );
    hits.set(key, recent);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  hits.set(key, recent);
  return { allowed: true };
}

export function checkDraftRateLimit(
  orgId: string,
  now: number = Date.now()
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  return checkBucket(orgId, WINDOW_MS, MAX_REQUESTS_PER_WINDOW, now);
}

/** Cap Super Admin draft generation when review has no businessId. */
export function checkSaUnassignedDraftRateLimit(
  userId: string,
  now: number = Date.now()
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  return checkBucket(
    `sa-unassigned:${userId}`,
    SA_UNASSIGNED_WINDOW_MS,
    SA_UNASSIGNED_MAX,
    now
  );
}

/** Test helper — clear buckets between cases. */
export function resetDraftRateLimitForTests(): void {
  hits.clear();
}
