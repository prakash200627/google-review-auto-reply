import { describe, expect, it } from "vitest";
import {
  normalizeBusinessPhone,
  PhoneValidationError,
} from "@/lib/business/phone";

describe("normalizeBusinessPhone", () => {
  it("normalizes valid international phone formatting", () => {
    expect(normalizeBusinessPhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalizeBusinessPhone("(415) 555-0199")).toBe("+4155550199");
    expect(normalizeBusinessPhone("+1 (415) 555-0199")).toBe("+14155550199");
  });

  it.each([
    ["letters", "+1 abc 415 555 0199"],
    ["misplaced plus", "415+5550199"],
    ["multiple plus signs", "++14155550199"],
    ["unsupported punctuation", "+1/415/555/0199"],
    ["too few digits", "1234567"],
    ["too many digits", "+1234567890123456"],
    ["unbalanced parentheses", "+1 (415 555-0199"],
  ])("rejects %s", (_label, input) => {
    expect(() => normalizeBusinessPhone(input)).toThrow(PhoneValidationError);
  });
});
