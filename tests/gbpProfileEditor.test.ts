import { describe, expect, it, vi } from "vitest";
import {
  buildGbpProfilePatch, gbpProfileFingerprint, normalizeGbpProfile,
  GBP_PROFILE_PATCH_TIMEOUT_MS, GbpProfileWriteUncertainError,
  patchGbpLocationPhone, patchGbpLocationProfile, validateGbpProfile, type GbpEditableProfile,
} from "@/lib/google/updateGbpProfile";

const profile: GbpEditableProfile = {
  title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: ["+14155550101"] },
  websiteUri: "https://example.com", categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [{ name: "gcid:bakery" }] },
  storefrontAddress: { revision: 0, addressLines: ["1 Main St"], locality: "Town", administrativeArea: "CA", postalCode: "90000", regionCode: "US" },
  regularHours: { periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 17 } }] },
  specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, closed: true }] },
};

describe("Google profile editor payloads", () => {
  it("normalizes the supported Google fields without coordinates", () => {
    const normalized = normalizeGbpProfile({ ...profile, latlng: { latitude: 1, longitude: 2 } });
    expect(normalized).toEqual(profile);
    expect(normalized).not.toHaveProperty("latlng");
    expect(gbpProfileFingerprint(normalized)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sends complete phone and category groups and accurate masks", () => {
    const proposed = { ...profile, phoneNumbers: { ...profile.phoneNumbers, primaryPhone: "+14155550200" }, categories: { ...profile.categories, primaryCategory: { name: "gcid:restaurant" } } };
    const patch = buildGbpProfilePatch(profile, proposed);
    expect(patch.body.phoneNumbers).toEqual(proposed.phoneNumbers);
    expect(patch.body.categories).toEqual(proposed.categories);
    expect(patch.updateMask).toBe("phoneNumbers,categories");
    expect(patch.changedFields).toEqual(["Phone numbers", "Business categories"]);
  });

  it("includes regular hours when special hours change and supports address periods", () => {
    const patch = buildGbpProfilePatch(profile, { ...profile, storefrontAddress: { ...profile.storefrontAddress, locality: "New Town" }, specialHours: { specialHourPeriods: [] } });
    expect(patch.updateMask).toBe("storefrontAddress,regularHours,specialHours");
    expect(patch.body.regularHours).toEqual(profile.regularHours);
  });

  it("produces no mask for identical values", () => {
    expect(buildGbpProfilePatch(profile, structuredClone(profile))).toEqual({ body: {}, updateMask: "", changedFields: [] });
  });

  it("rejects malformed fields and accepts formatted phone and Google hour structures", () => {
    expect(validateGbpProfile(profile)).toEqual([]);
    expect(validateGbpProfile({ ...profile, phoneNumbers: { primaryPhone: "123 ABC", additionalPhones: [] } }).map((issue) => issue.message)).toContain("Phone numbers must use valid digits and standard phone formatting.");
    expect(validateGbpProfile({ ...profile, categories: { ...profile.categories, additionalCategories: [{ name: "invalid" }] } }).map((issue) => issue.message).join(" ")).toContain("Additional categories");
  });

  it("PATCHes the location resource with one masked request and does not retry failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 }));
    await expect(patchGbpLocationProfile({ businessInfoName: "accounts/a/locations/l1", body: { title: "New" }, updateMask: "title", accessToken: "mock", actorRole: "superadmin", confirmed: true, env: { ALLOW_LIVE_GBP_PROFILE_WRITES: "true" }, fetchImpl: fetchMock as typeof fetch })).rejects.toBeInstanceOf(GbpProfileWriteUncertainError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/locations/l1?updateMask=title");
    expect(options.method).toBe("PATCH");
    expect(options.body).toBe(JSON.stringify({ title: "New" }));
  });

  it("legacy primary-phone updates send a complete phone group and group mask", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ phoneNumbers: { primaryPhone: "+14155550199", additionalPhones: [] } }), { status: 200 }));
    await patchGbpLocationPhone({ businessInfoName: "locations/l1", phone: "+14155550199", accessToken: "mock", actorRole: "superadmin", confirmed: true, env: { ALLOW_LIVE_GBP_PROFILE_WRITES: "true" }, fetchImpl: fetchMock as typeof fetch });
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("updateMask=phoneNumbers");
    expect(options.body).toBe(JSON.stringify({ phoneNumbers: { primaryPhone: "+14155550199", additionalPhones: [] } }));
  });

  it("legacy phone PATCH disables retries on uncertain HTTP failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 }));
    await expect(patchGbpLocationPhone({ businessInfoName: "locations/l1", phone: "+14155550199", accessToken: "mock", actorRole: "superadmin", confirmed: true, env: { ALLOW_LIVE_GBP_PROFILE_WRITES: "true" }, fetchImpl: fetchMock as typeof fetch })).rejects.toBeInstanceOf(GbpProfileWriteUncertainError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a bounded timeout and marks a timed-out write uncertain", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(patchGbpLocationProfile({ businessInfoName: "locations/l1", body: { title: "New" }, updateMask: "title", accessToken: "mock", actorRole: "superadmin", confirmed: true, env: { ALLOW_LIVE_GBP_PROFILE_WRITES: "true" }, fetchImpl: fetchMock as typeof fetch })).rejects.toMatchObject({ code: "google_write_uncertain", status: 504 });
    expect(GBP_PROFILE_PATCH_TIMEOUT_MS).toBe(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});
