import { describe, expect, it } from "vitest";
import {
  assertMutationOrigin,
  mutationOriginAllowed,
} from "@/lib/auth/requestOrigin";

describe("request origin CSRF checks", () => {
  const env = {
    APP_URL: "http://localhost:3000",
    NODE_ENV: "test",
  } as NodeJS.ProcessEnv;

  it("allows same-origin POST with matching Origin", () => {
    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(mutationOriginAllowed(req, env)).toBe(true);
    expect(assertMutationOrigin(req).ok).toBe(true);
  });

  it("rejects cross-site Origin on mutations", () => {
    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(mutationOriginAllowed(req, env)).toBe(false);
    const result = assertMutationOrigin(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it("allows GET without Origin (OAuth callback class)", () => {
    const req = new Request(
      "http://localhost:3000/api/auth/google/callback?code=x&state=y",
      { method: "GET", headers: { Origin: "https://accounts.google.com" } }
    );
    expect(mutationOriginAllowed(req, env)).toBe(true);
  });

  it("allows non-browser clients with neither Origin nor Referer", () => {
    const req = new Request("http://localhost:3000/api/admin/owners", {
      method: "POST",
    });
    expect(mutationOriginAllowed(req, env)).toBe(true);
  });

  it("rejects mismatched Referer when Origin is absent", () => {
    const req = new Request("http://localhost:3000/api/admin/owners", {
      method: "POST",
      headers: { Referer: "https://evil.example/attack" },
    });
    expect(mutationOriginAllowed(req, env)).toBe(false);
  });
});
