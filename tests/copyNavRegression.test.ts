import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("post-redesign navigation copy", () => {
  it("does not point operators to Settings → Google or Discover on Reviews", () => {
    const files = [
      "components/ReviewsPanel.tsx",
      "components/AdminBusinessesPanel.tsx",
      "app/orm/page.tsx",
      "README.md",
      "lib/org/requireOrg.ts",
    ];
    for (const file of files) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src).not.toMatch(/Settings\s*→\s*Google/);
      expect(src).not.toMatch(/Discover on Reviews/);
    }
  });

  it("owner tool pages link to /orm not /dashboard", () => {
    for (const file of [
      "app/billing/page.tsx",
      "app/reports/page.tsx",
      "app/seo/page.tsx",
      "app/services/page.tsx",
    ]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src).toMatch(/href=\"\/orm\"/);
      expect(src).not.toMatch(/href=\"\/dashboard\"/);
    }
  });
});
