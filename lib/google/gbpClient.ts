import {
  classifyGoogleApiErrorBody,
  GoogleBusinessApiError,
} from "@/lib/google/gbpErrors";
import {
  computeBackoffDelayMs,
  defaultRetryPolicyForMethod,
  defaultSleep,
  GOOGLE_API_RETRY_MAX_ATTEMPTS,
  GOOGLE_API_RETRY_MAX_TOTAL_MS,
  parseRetryAfterMs,
  shouldRetryGoogleResponse,
  type GoogleApiRetryPolicy,
} from "@/lib/google/retry";

export const ACCOUNT_MANAGEMENT_BASE =
  "https://mybusinessaccountmanagement.googleapis.com/v1";
export const BUSINESS_INFORMATION_BASE =
  "https://mybusinessbusinessinformation.googleapis.com/v1";
export const MYBUSINESS_V4_BASE = "https://mybusiness.googleapis.com/v4";
/** My Business Verifications API v1 */
export const VERIFICATIONS_BASE =
  "https://mybusinessverifications.googleapis.com/v1";

const MAX_JSON_ERROR_BYTES = 2048;

type FetchLike = typeof fetch;

export type GoogleApiCallOptions = {
  /**
   * Retry policy. Defaults: GET/PUT/PATCH retry transient 429/5xx;
   * POST/DELETE do not retry unless explicitly enabled (e.g. create with requestId).
   */
  retry?: Partial<GoogleApiRetryPolicy> | boolean;
};

function resolveRetryPolicy(
  method: string,
  options?: GoogleApiCallOptions
): GoogleApiRetryPolicy {
  const defaults = defaultRetryPolicyForMethod(method);
  if (options?.retry === false) return { enabled: false };
  if (options?.retry === true) return { ...defaults, enabled: true };
  if (options?.retry && typeof options.retry === "object") {
    return { ...defaults, ...options.retry };
  }
  return defaults;
}

async function googleApiRequestJson<T>(
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  url: string,
  accessToken: string,
  body: unknown | undefined,
  fetchImpl: FetchLike,
  callOptions?: GoogleApiCallOptions
): Promise<T> {
  if (!accessToken) {
    throw new GoogleBusinessApiError("Missing Google access token", {
      code: "unauthenticated",
      status: 401,
    });
  }

  const policy = resolveRetryPolicy(method, callOptions);
  const maxAttempts = policy.maxAttempts ?? GOOGLE_API_RETRY_MAX_ATTEMPTS;
  const maxTotalMs = policy.maxTotalMs ?? GOOGLE_API_RETRY_MAX_TOTAL_MS;
  const sleep = policy.sleep ?? defaultSleep;
  const now = policy.now ?? Date.now;
  const started = now();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let attempt = 0;
  while (true) {
    attempt += 1;
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }

    if (response.ok) {
      return (parsed ?? {}) as T;
    }

    const elapsedMs = now() - started;
    const retry = shouldRetryGoogleResponse({
      status: response.status,
      attempt,
      maxAttempts,
      elapsedMs,
      maxTotalMs,
      policyEnabled: policy.enabled,
    });

    if (retry) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers?.get?.("Retry-After") ??
          response.headers?.get?.("retry-after") ??
          null,
        now()
      );
      const delay = computeBackoffDelayMs({
        attemptIndex: attempt - 1,
        baseDelayMs: policy.baseDelayMs,
        maxDelayMs: policy.maxDelayMs,
        retryAfterMs,
        random: policy.random,
      });
      const remaining = maxTotalMs - (now() - started);
      if (remaining <= 0) {
        // fall through to throw
      } else {
        await sleep(Math.min(delay, remaining));
        continue;
      }
    }

    console.error(
      "Google Business API request failed:",
      method,
      response.status,
      url.replace(/access_token=[^&]+/gi, "access_token=REDACTED").slice(0, 200)
    );
    throw classifyGoogleApiErrorBody(
      response.status,
      parsed ?? { error: { message: text.slice(0, MAX_JSON_ERROR_BYTES) } }
    );
  }
}

/**
 * Authenticated GET against a Google API. Never logs tokens or raw bodies.
 * Retries transient 429/5xx by default.
 */
export async function googleApiGetJson<T>(
  url: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  callOptions?: GoogleApiCallOptions
): Promise<T> {
  return googleApiRequestJson<T>(
    "GET",
    url,
    accessToken,
    undefined,
    fetchImpl,
    callOptions
  );
}

/**
 * Authenticated PUT against a Google API. Never logs tokens or raw bodies.
 * Retries transient 429/5xx by default — callers that must not retry
 * (e.g. publish under a claim lease) pass `{ retry: false }`.
 */
export async function googleApiPutJson<T>(
  url: string,
  accessToken: string,
  body: unknown,
  fetchImpl: FetchLike = fetch,
  callOptions?: GoogleApiCallOptions
): Promise<T> {
  return googleApiRequestJson<T>(
    "PUT",
    url,
    accessToken,
    body,
    fetchImpl,
    callOptions
  );
}

export async function googleApiPatchJson<T>(
  url: string,
  accessToken: string,
  body: unknown,
  fetchImpl: FetchLike = fetch,
  callOptions?: GoogleApiCallOptions
): Promise<T> {
  return googleApiRequestJson<T>(
    "PATCH",
    url,
    accessToken,
    body,
    fetchImpl,
    callOptions
  );
}

/**
 * Authenticated POST against a Google API. Never logs tokens or raw bodies.
 * Does not retry by default (non-idempotent). Opt in with `{ retry: true }`
 * only when the call has a safe idempotency mechanism (e.g. Google requestId).
 */
export async function googleApiPostJson<T>(
  url: string,
  accessToken: string,
  body: unknown,
  fetchImpl: FetchLike = fetch,
  callOptions?: GoogleApiCallOptions
): Promise<T> {
  return googleApiRequestJson<T>(
    "POST",
    url,
    accessToken,
    body,
    fetchImpl,
    callOptions
  );
}

export function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | undefined>
): string {
  const url = new URL(
    path.startsWith("http")
      ? path
      : `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
