import { describe, expect, it } from "vitest";
import {
  homePathForRole,
  LEGACY_ROUTE_REDIRECTS,
  resolveLegacyRedirect,
} from "@/lib/auth/homePath";

describe("homePathForRole", () => {
  it("sends Super Admin to the admin dashboard", () => {
    expect(homePathForRole("superadmin")).toBe("/admin/dashboard");
  });

  it("sends Business Admins and unknown roles to ORM", () => {
    expect(homePathForRole("business_owner")).toBe("/orm");
    expect(homePathForRole(undefined)).toBe("/orm");
  });
});

describe("legacy route redirects", () => {
  it("maps legacy paths to ORM/GMB modules", () => {
    expect(LEGACY_ROUTE_REDIRECTS["/dashboard"]).toBe("/orm");
    expect(LEGACY_ROUTE_REDIRECTS["/reviews"]).toBe("/orm/reviews");
    expect(LEGACY_ROUTE_REDIRECTS["/settings/google"]).toBe("/gmb");
    expect(LEGACY_ROUTE_REDIRECTS["/admin/groups"]).toBeUndefined();
  });

  it("preserves query strings when resolving redirects", () => {
    expect(resolveLegacyRedirect("/dashboard", "?businessId=abc")).toBe(
      "/orm?businessId=abc"
    );
    expect(resolveLegacyRedirect("/unknown")).toBeNull();
  });
});
