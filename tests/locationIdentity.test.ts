import { describe, expect, it } from "vitest";
import {
  buildLocationIdentityKey,
  clampAdminLocationLimit,
  clampAdminLocationOffset,
  dedupeLocationsByIdentity,
  locationListKey,
  normalizeGoogleLocationName,
  paginateSlice,
} from "@/lib/location/identity";

describe("location identity", () => {
  it("accepts full Google reviews location resource names only", () => {
    expect(
      normalizeGoogleLocationName("accounts/1/locations/2")
    ).toBe("accounts/1/locations/2");
    expect(normalizeGoogleLocationName("locations/2")).toBeNull();
    expect(normalizeGoogleLocationName(undefined)).toBeNull();
    expect(normalizeGoogleLocationName("")).toBeNull();
    expect(normalizeGoogleLocationName("Amnesia Lounge Bar")).toBeNull();
  });

  it("never builds identity keys containing undefined", () => {
    expect(buildLocationIdentityKey("org1", undefined)).toBeNull();
    expect(buildLocationIdentityKey(undefined, "accounts/1/locations/2")).toBeNull();
    expect(buildLocationIdentityKey("org1", "accounts/1/locations/2")).toBe(
      "org1::accounts/1/locations/2"
    );
    expect(
      locationListKey(buildLocationIdentityKey("org1", undefined), "abc")
    ).toBe("doc:abc");
  });

  it("dedupes identical resource ids and keeps same-name distinct ids", () => {
    const { unique, skippedInvalid, duplicateCollapsed } =
      dedupeLocationsByIdentity([
        {
          orgId: "org1",
          googleLocationName: "accounts/1/locations/a",
          title: "24 Roots",
          address: "",
          businessId: null,
          updatedAt: new Date("2026-01-01"),
          _id: "1",
        },
        {
          orgId: "org1",
          googleLocationName: "accounts/1/locations/a",
          title: "24 Roots",
          address: "Addr",
          businessId: "biz1",
          updatedAt: new Date("2026-02-01"),
          _id: "2",
        },
        {
          orgId: "org1",
          googleLocationName: "accounts/1/locations/b",
          title: "24 Roots",
          address: "Other",
          businessId: null,
          updatedAt: new Date("2026-03-01"),
          _id: "3",
        },
        {
          orgId: "org1",
          googleLocationName: undefined,
          title: "Broken",
          _id: "4",
        },
        {
          orgId: "org2",
          googleLocationName: "accounts/9/locations/z",
          title: "Other org",
          _id: "5",
        },
      ]);

    expect(skippedInvalid).toBe(1);
    expect(duplicateCollapsed).toBe(1);
    expect(unique).toHaveLength(3);
    const roots = unique.filter((r) => r.title === "24 Roots");
    expect(roots).toHaveLength(2);
    expect(String(roots[0].googleLocationName)).not.toBe(
      String(roots[1].googleLocationName)
    );
    const collapsed = unique.find(
      (r) => r.googleLocationName === "accounts/1/locations/a"
    );
    expect(String(collapsed?.businessId)).toBe("biz1");
  });

  it("does not merge missing addresses into one row", () => {
    const { unique } = dedupeLocationsByIdentity([
      {
        orgId: "org1",
        googleLocationName: "accounts/1/locations/1",
        title: "Amnesia Lounge Bar",
        address: "",
        _id: "1",
      },
      {
        orgId: "org1",
        googleLocationName: "accounts/1/locations/2",
        title: "Amnesia Sky Bar",
        address: "",
        _id: "2",
      },
    ]);
    expect(unique).toHaveLength(2);
  });

  it("paginates without silently dropping remaining distinct rows", () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const first = paginateSlice(items, 0, 2);
    expect(first.page).toEqual([0, 1]);
    expect(first.hasMore).toBe(true);
    expect(first.totalMatched).toBe(5);
    const second = paginateSlice(items, 2, 2);
    expect(second.page).toEqual([2, 3]);
    expect(second.hasMore).toBe(true);
    const last = paginateSlice(items, 4, 2);
    expect(last.page).toEqual([4]);
    expect(last.hasMore).toBe(false);
  });

  it("clamps limit and offset", () => {
    expect(clampAdminLocationLimit(999)).toBe(120);
    expect(clampAdminLocationLimit(0)).toBe(80);
    expect(clampAdminLocationLimit(null)).toBe(80);
    expect(clampAdminLocationLimit(undefined)).toBe(80);
    expect(clampAdminLocationLimit(2)).toBe(2);
    expect(clampAdminLocationOffset(-3)).toBe(0);
    expect(clampAdminLocationOffset("10")).toBe(10);
  });
});
