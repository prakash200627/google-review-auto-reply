import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("TRONX login vs Google OAuth separation", () => {
  it("login route uses email/password hashing and never starts Google OAuth", () => {
    const login = readFileSync(
      join(process.cwd(), "app/api/auth/login/route.ts"),
      "utf8"
    );
    expect(login).toMatch(/verifyPassword/);
    expect(login).toMatch(/hashPassword/);
    expect(login).toMatch(/applyUserSessionCookie/);
    expect(login).not.toMatch(/startAuthorization/);
    expect(login).not.toMatch(/accounts\.google\.com/);
  });

  it("Google OAuth start is Super Admin only", () => {
    const start = readFileSync(
      join(process.cwd(), "app/api/auth/google/start/route.ts"),
      "utf8"
    );
    expect(start).toMatch(/superadmin/);
    expect(start).toMatch(/superadmin_required|Only Super Admin/);
    expect(start).toMatch(/connectionSource:\s*"platform"/);
  });

  it("canonical module routes exist", () => {
    const pages = [
      "app/admin/page.tsx",
      "app/orm/page.tsx",
      "app/orm/reviews/page.tsx",
      "app/orm/groups/page.tsx",
      "app/gmb/page.tsx",
      "app/gmb/locations/page.tsx",
      "app/gmb/locations/[locationId]/page.tsx",
      "app/login/page.tsx",
    ];
    for (const page of pages) {
      expect(() =>
        readFileSync(join(process.cwd(), page), "utf8")
      ).not.toThrow();
    }
  });

  it("legacy pages redirect to ORM/GMB modules", () => {
    const dashboard = readFileSync(
      join(process.cwd(), "app/dashboard/page.tsx"),
      "utf8"
    );
    const reviews = readFileSync(
      join(process.cwd(), "app/reviews/page.tsx"),
      "utf8"
    );
    const google = readFileSync(
      join(process.cwd(), "app/settings/google/page.tsx"),
      "utf8"
    );
    expect(dashboard).toMatch(/redirect\(/);
    expect(dashboard).toMatch(/\/orm/);
    expect(reviews).toMatch(/\/orm\/reviews/);
    expect(google).toMatch(/\/gmb/);
  });
});
