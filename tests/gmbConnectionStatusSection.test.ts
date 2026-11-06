import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("GMB connection status Suspense isolation", () => {
  it("gmb hub does not await getSafeGoogleConnectionStatus in the page body", () => {
    const page = readFileSync(
      join(process.cwd(), "app/gmb/page.tsx"),
      "utf8"
    );
    expect(page).toMatch(/Suspense/);
    expect(page).toMatch(/GmbConnectionStatusSection/);
    expect(page).toMatch(/GoogleStatusFallback|Loading connection status/);
    expect(page).not.toMatch(/getSafeGoogleConnectionStatus/);
    expect(page).not.toMatch(/listActiveBusinessIdsForUser/);
  });

  it("status section loads Google status server-side and gates connect on SA", () => {
    const src = readFileSync(
      join(process.cwd(), "components/gmb/GmbConnectionStatusSection.tsx"),
      "utf8"
    );
    expect(src).toMatch(/getSafeGoogleConnectionStatus/);
    expect(src).toMatch(/allowConnect=\{isSuperAdmin\}/);
    expect(src).toMatch(/role=\{isSuperAdmin \? "superadmin" : "business_owner"\}/);
    expect(src).toMatch(/requireAuthUser/);
    // Must not hardcode allowConnect true for everyone.
    expect(src).not.toMatch(/allowConnect=\{true\}/);
  });

  it("GoogleConnectPanel still refuses OAuth UI without allowConnect", () => {
    const src = readFileSync(
      join(process.cwd(), "components/GoogleConnectPanel.tsx"),
      "utf8"
    );
    expect(src).toMatch(/if \(!allowConnect\)/);
    expect(src).toMatch(/Only Super Admin can disconnect/);
  });
});
