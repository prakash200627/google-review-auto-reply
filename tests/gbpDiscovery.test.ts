import { describe, expect, it, vi } from "vitest";
import {
  listAllAccounts,
  listAllReviewsForLocation,
  mapStarRating,
  toReviewsLocationName,
} from "@/lib/google/gbpDiscovery";
import { classifyGoogleApiErrorBody } from "@/lib/google/gbpErrors";
import { googleApiGetJson } from "@/lib/google/gbpClient";

describe("gbp discovery helpers", () => {
  it("maps star ratings and builds reviews location names", () => {
    expect(mapStarRating("FIVE")).toBe(5);
    expect(mapStarRating("ONE")).toBe(1);
    expect(mapStarRating("STAR_RATING_UNSPECIFIED")).toBeNull();
    expect(
      toReviewsLocationName("accounts/123", "locations/456")
    ).toBe("accounts/123/locations/456");
    expect(toReviewsLocationName("bad", "locations/456")).toBeNull();
  });

  it("classifies permission and auth errors safely", () => {
    const denied = classifyGoogleApiErrorBody(403, {
      error: {
        status: "PERMISSION_DENIED",
        message: "Google My Business API has not been used in project 123 before or it is disabled.",
      },
    });
    expect(denied.code).toBe("api_disabled");
    expect(denied.message).not.toMatch(/project 123/);
    expect(denied.message.toLowerCase()).toMatch(/disabled|denied|unavailable/);

    const unauth = classifyGoogleApiErrorBody(401, {
      error: { status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials." },
    });
    expect(unauth.code).toBe("unauthenticated");
  });

  it("paginates accounts until nextPageToken is exhausted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            accounts: [{ name: "accounts/1" }],
            nextPageToken: "page-2",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            accounts: [{ name: "accounts/2" }],
          }),
      });

    const accounts = await listAllAccounts("access", fetchImpl);
    expect(accounts.map((a) => a.name)).toEqual(["accounts/1", "accounts/2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("paginates reviews and preserves totalReviewCount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            reviews: [{ name: "accounts/1/locations/2/reviews/a", starRating: "FIVE" }],
            nextPageToken: "more",
            totalReviewCount: 2,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            reviews: [{ name: "accounts/1/locations/2/reviews/b", starRating: "FOUR" }],
            totalReviewCount: 2,
          }),
      });

    const result = await listAllReviewsForLocation(
      "access",
      "accounts/1/locations/2",
      fetchImpl
    );
    expect(result.reviews).toHaveLength(2);
    expect(result.totalReviewCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("googleApiGetJson never returns tokens and maps HTTP failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: { status: "PERMISSION_DENIED", message: "Denied" },
        }),
    });

    await expect(
      googleApiGetJson("https://example.test/v1/accounts", "secret-token", fetchImpl)
    ).rejects.toMatchObject({ code: "permission_denied" });

    const authHeader = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(authHeader.Authorization).toBe("Bearer secret-token");
  });
});
