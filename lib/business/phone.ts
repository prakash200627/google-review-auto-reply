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
  if (typeof raw !== "string") {
    throw new PhoneValidationError("Phone number must be provided as text.");
  }
  const input = raw.trim();
  if (!input) return "";
  if (!/^[+0-9\s()-]+$/.test(input)) {
    throw new PhoneValidationError(
      "Phone number may contain only digits, spaces, parentheses, hyphens, and one leading +."
    );
  }
  const plusIndex = input.indexOf("+");
  if (plusIndex > 0 || input.indexOf("+", plusIndex + 1) !== -1) {
    throw new PhoneValidationError("The + sign is only allowed once at the start of a phone number.");
  }
  let parenthesisDepth = 0;
  let parenthesisDigits = 0;
  for (const char of input) {
    if (char === "(") {
      if (parenthesisDepth !== 0) {
        throw new PhoneValidationError("Phone number parentheses are malformed.");
      }
      parenthesisDepth = 1;
      parenthesisDigits = 0;
    } else if (char === ")") {
      if (parenthesisDepth !== 1 || parenthesisDigits === 0) {
        throw new PhoneValidationError("Phone number parentheses are malformed.");
      }
      parenthesisDepth = 0;
    } else if (parenthesisDepth === 1 && /\d/.test(char)) {
      parenthesisDigits += 1;
    }
  }
  if (parenthesisDepth !== 0) {
    throw new PhoneValidationError("Phone number parentheses are malformed.");
  }
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new PhoneValidationError(
      "Phone number must contain 8–15 digits (E.164-compatible)."
    );
  }
  return `+${digits}`;
}
