import { describe, expect, it } from "vitest";
import {
  decodeUserSession,
  encodeUserSession,
} from "@/lib/auth/userSession";

describe("user session tokens", () => {
  it("round-trips a signed session and rejects tampering", () => {
    process.env.AUTH_SECRET = "test-auth-secret-value-32chars!!";
    const token = encodeUserSession({
      userId: "507f1f77bcf86cd799439011",
      role: "superadmin",
      email: "admin@example.com",
      exp: Date.now() + 60_000,
    });
    const decoded = decodeUserSession(token);
    expect(decoded?.email).toBe("admin@example.com");
    expect(decoded?.role).toBe("superadmin");

    const [body] = token.split(".");
    const tampered = `${body}.tampered-signature-value`;
    expect(decodeUserSession(tampered)).toBeNull();
  });

  it("rejects expired sessions", () => {
    process.env.AUTH_SECRET = "test-auth-secret-value-32chars!!";
    const token = encodeUserSession({
      userId: "507f1f77bcf86cd799439011",
      role: "business_owner",
      email: "owner@example.com",
      exp: Date.now() - 1000,
    });
    expect(decodeUserSession(token)).toBeNull();
  });
});
