import { describe, expect, it, vi } from "vitest";
import {
  AUTH_ME_TIMEOUT_MS,
  fetchAuthMe,
} from "@/components/auth/AuthNavProvider";
import {
  guestNavItems,
  isPrimaryNavActive,
  isSecondaryNavActive,
  loadingSafeNavItems,
  moduleSecondaryItems,
  moduleSwitcherItems,
} from "@/components/nav/navConfig";

describe("fetchAuthMe", () => {
  it("maps a successful me payload without inventing roles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        user: {
          id: "u1",
          email: "sa@example.com",
          role: "superadmin",
        },
      }),
    });
    const result = await fetchAuthMe(fetchImpl, 5_000);
    expect(result).toEqual({
      ok: true,
      user: {
        id: "u1",
        email: "sa@example.com",
        role: "superadmin",
      },
    });
  });

  it("treats 401 as guest unauthorized", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ success: false }),
    });
    const result = await fetchAuthMe(fetchImpl, 5_000);
    expect(result).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("times out when the request never settles", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );
    const started = Date.now();
    const result = await fetchAuthMe(fetchImpl, 50);
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("exports a positive default timeout bound", () => {
    expect(AUTH_ME_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);
    expect(AUTH_ME_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("navConfig role separation", () => {
  it("loading-safe nav never includes Admin or guest Sign in", () => {
    const items = loadingSafeNavItems();
    const hrefs = items.map((i) => i.href);
    expect(hrefs).not.toContain("/login");
    expect(hrefs).not.toContain("/admin");
    expect(hrefs).not.toContain("/admin/dashboard");
    expect(items).toEqual([]);
  });

  it("admin secondary nav is dashboard-first without a duplicate Home", () => {
    const items = moduleSecondaryItems("admin", "superadmin");
    const hrefs = items.map((i) => i.href);
    expect(hrefs[0]).toBe("/admin/dashboard");
    expect(hrefs).toContain("/admin/groups");
    expect(hrefs).not.toContain("/admin");
    expect(hrefs.filter((h) => h === "/admin/dashboard")).toHaveLength(1);
  });

  it("guest nav is Sign in only — no protected workspace links", () => {
    const items = guestNavItems();
    expect(items).toEqual([{ href: "/login", label: "Sign in" }]);
    expect(items.some((i) => i.href.startsWith("/orm"))).toBe(false);
    expect(items.some((i) => i.href.startsWith("/gmb"))).toBe(false);
    expect(items.some((i) => i.href.startsWith("/admin"))).toBe(false);
  });

  it("module switcher includes Admin dashboard only for superadmin", () => {
    expect(moduleSwitcherItems("superadmin").map((i) => i.href)).toContain(
      "/admin/dashboard"
    );
    expect(
      moduleSwitcherItems("business_owner").map((i) => i.href)
    ).not.toContain("/admin/dashboard");
    expect(
      moduleSwitcherItems("business_owner").map((i) => i.href)
    ).not.toContain("/admin");
  });

  it("GMB create location is SA-only in secondary nav", () => {
    const sa = moduleSecondaryItems("gmb", "superadmin").map((i) => i.href);
    const ba = moduleSecondaryItems("gmb", "business_owner").map((i) => i.href);
    expect(sa).toContain("/gmb/locations/create");
    expect(ba).not.toContain("/gmb/locations/create");
  });

  it("admin secondary nav is empty for business owners", () => {
    expect(moduleSecondaryItems("admin", "business_owner")).toEqual([]);
  });

  it("ORM secondary keeps Groups for BA only; SA manages groups under Admin", () => {
    const ba = moduleSecondaryItems("orm", "business_owner").map((i) => i.href);
    const sa = moduleSecondaryItems("orm", "superadmin").map((i) => i.href);
    expect(ba).toContain("/orm/groups");
    expect(sa).not.toContain("/orm/groups");
    expect(moduleSecondaryItems("admin", "superadmin").map((i) => i.href)).toContain(
      "/admin/groups"
    );
  });

  it("primary nav highlights the owning workspace", () => {
    expect(isPrimaryNavActive("/orm/reviews", "/orm")).toBe(true);
    expect(isPrimaryNavActive("/billing", "/orm")).toBe(true);
    expect(isPrimaryNavActive("/gmb/locations", "/gmb")).toBe(true);
    expect(isPrimaryNavActive("/admin/businesses", "/admin/dashboard")).toBe(
      true
    );
    expect(isPrimaryNavActive("/account", "/account")).toBe(true);
    expect(isPrimaryNavActive("/orm", "/gmb")).toBe(false);
  });

  it("secondary nav prefers the longest matching href", () => {
    const items = moduleSecondaryItems("orm", "business_owner");
    expect(isSecondaryNavActive("/orm", "/orm", items)).toBe(true);
    expect(isSecondaryNavActive("/orm/reviews", "/orm", items)).toBe(false);
    expect(isSecondaryNavActive("/orm/reviews", "/orm/reviews", items)).toBe(
      true
    );
  });
});
