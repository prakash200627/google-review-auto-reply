import { describe, expect, it } from "vitest";
import {
  OwnerAccountError,
  validateOwnerEmail,
  validateOwnerPassword,
} from "@/lib/business/owners";

describe("owner account validation", () => {
  it("rejects invalid emails", () => {
    expect(() => validateOwnerEmail("")).toThrow(OwnerAccountError);
    expect(() => validateOwnerEmail("not-an-email")).toThrow(/valid owner email/i);
    expect(validateOwnerEmail(" Owner@Example.COM ")).toBe("owner@example.com");
  });

  it("requires strong enough passwords when creating owners", () => {
    expect(() => validateOwnerPassword("short", true)).toThrow(/8 characters/);
    expect(validateOwnerPassword("long-enough", true)).toBe("long-enough");
    expect(validateOwnerPassword("", false)).toBe("");
  });
});
