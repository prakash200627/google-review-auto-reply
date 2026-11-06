/**
 * In-memory login throttle (failed-attempt aware).
 *
 * Limitations: counters are per Node process. Multi-instance / serverless
 * deployments do not share buckets — each instance enforces limits independently.
 * Sufficient for single-instance staging/local; use a shared store later if needed.
 *
 * Design: throttle by IP (all attempts) and by email+IP (failures only) so an
 * attacker targeting one email from many IPs cannot permanently lock the victim
 * via an email-only lockout, while a single IP cannot spray unlimited guesses.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_IP = 25;
const MAX_FAILURES_PER_EMAIL_IP = 8;

const ipAttempts = new Map<string, number[]>();
const emailIpFailures = new Map<string, number[]>();

function prune(timestamps: number[], now: number): number[] {
  return timestamps.filter((t) => now - t < WINDOW_MS);
}

function retryAfterSec(timestamps: number[], now: number): number {
  const oldest = timestamps[0] ?? now;
  return Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
}

export function normalizeLoginEmail(email: string): string {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 128);
  return "unknown";
}

function emailIpKey(email: string, ip: string): string {
  return `${normalizeLoginEmail(email)}|${ip}`;
}

/**
 * Call before verifying credentials. Counts toward the IP attempt budget.
 */
export function checkLoginRateLimit(input: {
  ip: string;
  email: string;
  now?: number;
}): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const now = input.now ?? Date.now();
  const ip = String(input.ip || "unknown").slice(0, 128);
  const email = normalizeLoginEmail(input.email);

  const ipRecent = prune(ipAttempts.get(ip) || [], now);
  if (ipRecent.length >= MAX_ATTEMPTS_PER_IP) {
    ipAttempts.set(ip, ipRecent);
    return { allowed: false, retryAfterSec: retryAfterSec(ipRecent, now) };
  }

  const pairKey = emailIpKey(email, ip);
  const failRecent = prune(emailIpFailures.get(pairKey) || [], now);
  if (failRecent.length >= MAX_FAILURES_PER_EMAIL_IP) {
    emailIpFailures.set(pairKey, failRecent);
    return { allowed: false, retryAfterSec: retryAfterSec(failRecent, now) };
  }

  ipRecent.push(now);
  ipAttempts.set(ip, ipRecent);
  return { allowed: true };
}

export function recordLoginFailure(input: {
  ip: string;
  email: string;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const key = emailIpKey(input.email, input.ip);
  const recent = prune(emailIpFailures.get(key) || [], now);
  recent.push(now);
  emailIpFailures.set(key, recent);
}

export function clearLoginFailures(input: {
  ip: string;
  email: string;
}): void {
  emailIpFailures.delete(emailIpKey(input.email, input.ip));
}

/** Test helper. */
export function resetLoginRateLimitForTests(): void {
  ipAttempts.clear();
  emailIpFailures.clear();
}

export const LOGIN_RATE_LIMIT_WINDOW_MS = WINDOW_MS;
export const LOGIN_RATE_LIMIT_MAX_IP = MAX_ATTEMPTS_PER_IP;
export const LOGIN_RATE_LIMIT_MAX_EMAIL_IP = MAX_FAILURES_PER_EMAIL_IP;
