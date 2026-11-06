import { describe, expect, it } from "vitest";
import {
  PaymentValidationError,
  validateManualPaymentInput,
} from "@/lib/billing/paymentValidation";

describe("validateManualPaymentInput", () => {
  it("rejects received with zero amount", () => {
    expect(() =>
      validateManualPaymentInput({
        status: "received",
        amountExpectedCents: 1000,
        amountReceivedCents: 0,
      })
    ).toThrow(PaymentValidationError);
  });

  it("allows expected with zero received", () => {
    expect(() =>
      validateManualPaymentInput({
        status: "expected",
        amountExpectedCents: 1000,
        amountReceivedCents: 0,
      })
    ).not.toThrow();
  });

  it("rejects invalid status transitions", () => {
    expect(() =>
      validateManualPaymentInput({
        status: "not_recorded",
        amountExpectedCents: 0,
        amountReceivedCents: 0,
        previousStatus: "received",
      })
    ).toThrow(/transition/i);
  });
});
