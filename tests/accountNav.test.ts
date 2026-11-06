import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Account navigation wiring", () => {
  it("root layout wraps the app in AuthNavProvider", () => {
    const src = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
    expect(src).toMatch(/AuthNavProvider/);
  });

  it("AppChrome / AppShell consume useAuthNav instead of fetching /api/auth/me", () => {
    const chrome = readFileSync(
      join(process.cwd(), "components/nav/AppChrome.tsx"),
      "utf8"
    );
    const shell = readFileSync(
      join(process.cwd(), "components/AppShell.tsx"),
      "utf8"
    );
    expect(chrome).toMatch(/useAuthNav/);
    expect(chrome).not.toMatch(/fetch\("\/api\/auth\/me"/);
    expect(chrome).toMatch(/href:\s*"\/account"/);
    expect(chrome).toMatch(/label:\s*"Account"/);
    expect(shell).toMatch(/AppChrome/);
    expect(shell).not.toMatch(/fetch\("\/api\/auth\/me"/);
  });

  it("module layouts exist for orm, gmb, admin, and account", () => {
    for (const mod of ["orm", "gmb", "admin", "account"]) {
      const src = readFileSync(
        join(process.cwd(), `app/${mod}/layout.tsx`),
        "utf8"
      );
      expect(src).toMatch(/ModuleShell/);
      expect(src).toMatch(new RegExp(`module="${mod}"`));
    }
  });

  it("AuthNavProvider bounds /api/auth/me with abort timeout", () => {
    const src = readFileSync(
      join(process.cwd(), "components/auth/AuthNavProvider.tsx"),
      "utf8"
    );
    expect(src).toMatch(/AUTH_ME_TIMEOUT_MS/);
    expect(src).toMatch(/AbortController/);
    expect(src).toMatch(/session_check_timeout/);
  });

  it("login page refreshes auth nav after success", () => {
    const src = readFileSync(join(process.cwd(), "app/login/page.tsx"), "utf8");
    expect(src).toMatch(/useAuthNav/);
    expect(src).toMatch(/refresh\(/);
    expect(src).toMatch(/homePathForRole/);
  });

  it("logout clears guest nav state", () => {
    const src = readFileSync(
      join(process.cwd(), "components/AccountLogoutButton.tsx"),
      "utf8"
    );
    expect(src).toMatch(/clearToGuest/);
    expect(src).toMatch(/\/api\/auth\/logout/);
  });
});
