import { describe, expect, it, vi } from "vitest";
import {
  computeBackoffDelayMs,
  isTransientGoogleHttpStatus,
  parseRetryAfterMs,
  shouldRetryGoogleResponse,
} from "@/lib/google/retry";
import { googleApiGetJson, googleApiPostJson, googleApiPutJson } from "@/lib/google/gbpClient";

describe("Google API retry helpers", () => {
  it("treats only 429 and 5xx as transient", () => {
    expect(isTransientGoogleHttpStatus(429)).toBe(true);
    expect(isTransientGoogleHttpStatus(500)).toBe(true);
    expect(isTransientGoogleHttpStatus(503)).toBe(true);
    expect(isTransientGoogleHttpStatus(400)).toBe(false);
    expect(isTransientGoogleHttpStatus(401)).toBe(false);
    expect(isTransientGoogleHttpStatus(403)).toBe(false);
    expect(isTransientGoogleHttpStatus(409)).toBe(false);
  });

  it("parses Retry-After seconds and HTTP-date", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    const future = new Date(Date.now() + 1500).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });

  it("applies exponential backoff with jitter and Retry-After floor", () => {
    const delay = computeBackoffDelayMs({
      attemptIndex: 2,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      retryAfterMs: 500,
      random: () => 0.5,
    });
    expect(delay).toBeGreaterThanOrEqual(500);
  });

  it("stops retrying when attempts or total budget exhausted", () => {
    expect(
      shouldRetryGoogleResponse({
        status: 503,
        attempt: 4,
        maxAttempts: 4,
        elapsedMs: 100,
        maxTotalMs: 12_000,
        policyEnabled: true,
      })
    ).toBe(false);
    expect(
      shouldRetryGoogleResponse({
        status: 503,
        attempt: 1,
        maxAttempts: 4,
        elapsedMs: 12_000,
        maxTotalMs: 12_000,
        policyEnabled: true,
      })
    ).toBe(false);
  });
});

describe("googleApi* retry behavior", () => {
  it("retries GET on 429 then succeeds, honoring Retry-After", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? "1" : null) },
        text: async () =>
          JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "slow" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ name: "accounts/1" }),
      });

    const result = await googleApiGetJson<{ name: string }>(
      "https://example.test/v1/accounts",
      "token",
      fetchImpl as unknown as typeof fetch,
      { retry: { enabled: true, sleep, random: () => 0, maxAttempts: 3, maxTotalMs: 10_000 } }
    );
    expect(result.name).toBe("accounts/1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
  });

  it("retries GET on 503 within attempt limits", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: "down" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ ok: true }),
      });

    await googleApiGetJson(
      "https://example.test/v1/x",
      "token",
      fetchImpl as unknown as typeof fetch,
      { retry: { enabled: true, sleep, random: () => 0, maxAttempts: 3 } }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent 4xx on GET", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "bad" } }),
    });

    await expect(
      googleApiGetJson(
        "https://example.test/v1/x",
        "token",
        fetchImpl as unknown as typeof fetch,
        { retry: { enabled: true, sleep: async () => undefined } }
      )
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry POST by default (verification-safe)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { message: "down" } }),
    });

    await expect(
      googleApiPostJson(
        "https://example.test/v1/verify",
        "token",
        { method: "EMAIL" },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry PUT when caller disables retries (publish-safe)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { message: "down" } }),
    });

    await expect(
      googleApiPutJson(
        "https://example.test/v1/reply",
        "token",
        { comment: "Thanks" },
        fetchImpl as unknown as typeof fetch,
        { retry: false }
      )
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
