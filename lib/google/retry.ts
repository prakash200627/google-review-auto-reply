/**
 * Bounded retry/backoff for transient Google API failures (429 / 5xx only).
 * Permanent 4xx (except 429) are never retried.
 */

export const GOOGLE_API_RETRY_MAX_ATTEMPTS = 4;
export const GOOGLE_API_RETRY_MAX_TOTAL_MS = 12_000;
export const GOOGLE_API_RETRY_BASE_DELAY_MS = 400;
export const GOOGLE_API_RETRY_MAX_DELAY_MS = 4_000;

export type GoogleApiRetryPolicy = {
  /** When false, never retry. */
  enabled: boolean;
  maxAttempts?: number;
  maxTotalMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable clock/sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

export function defaultRetryPolicyForMethod(
  method: string
): GoogleApiRetryPolicy {
  const m = method.toUpperCase();
  // GET/PUT/PATCH are treated as idempotent at the HTTP layer.
  // POST/DELETE default off — callers with requestId (create) opt in.
  if (m === "GET" || m === "PUT" || m === "PATCH" || m === "HEAD") {
    return { enabled: true };
  }
  return { enabled: false };
}

export function isTransientGoogleHttpStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

/**
 * Parse Retry-After as seconds or HTTP-date. Returns delay ms, or null.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now()
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, GOOGLE_API_RETRY_MAX_DELAY_MS * 2);
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const delta = when - nowMs;
  if (delta <= 0) return 0;
  return Math.min(delta, GOOGLE_API_RETRY_MAX_DELAY_MS * 2);
}

/** Exponential backoff with full jitter, capped. */
export function computeBackoffDelayMs(input: {
  attemptIndex: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAfterMs?: number | null;
  random?: () => number;
}): number {
  const base = input.baseDelayMs ?? GOOGLE_API_RETRY_BASE_DELAY_MS;
  const max = input.maxDelayMs ?? GOOGLE_API_RETRY_MAX_DELAY_MS;
  const rand = input.random ?? Math.random;
  const exp = Math.min(max, base * 2 ** Math.max(0, input.attemptIndex));
  const jittered = Math.floor(rand() * (exp + 1));
  const withHeader =
    input.retryAfterMs != null
      ? Math.max(jittered, input.retryAfterMs)
      : jittered;
  return Math.min(max, withHeader);
}

export async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryGoogleResponse(input: {
  status: number;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  maxTotalMs: number;
  policyEnabled: boolean;
}): boolean {
  if (!input.policyEnabled) return false;
  if (!isTransientGoogleHttpStatus(input.status)) return false;
  if (input.attempt >= input.maxAttempts) return false;
  if (input.elapsedMs >= input.maxTotalMs) return false;
  return true;
}
