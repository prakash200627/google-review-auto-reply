/** Normalize and validate business contact phone numbers (E.164-ish). */

export class PhoneValidationError extends Error {
  code: string;
  constructor(message: string, code = "invalid_phone") {
    super(message);
    this.name = "PhoneValidationError";
    this.code = code;
  }
}

/**
 * Accepts digits with optional leading +, spaces, dashes, parentheses.
 * Returns normalized "+<digits>" or empty string when clearing.
 */
export function normalizeBusinessPhone(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const input = String(raw).trim();
  if (!input) return "";
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new PhoneValidationError(
      "Phone number must contain 8–15 digits (E.164-compatible)."
    );
  }
  return `+${digits}`;
}
