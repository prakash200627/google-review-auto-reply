import { describe, expect, it } from "vitest";
import {
  PLAN_LIST_PRICE_CENTS,
  resolveLedgerAmountsCents,
  suggestedCatalogExpectedCents,
} from "@/lib/billing/planAmounts";

describe("suggestedCatalogExpectedCents", () => {
  it("returns Starter list price for active businesses", () => {
    expect(
      suggestedCatalogExpectedCents({
        planCode: "starter",
        business: { status: "active", active: true },
      })
    ).toBe(PLAN_LIST_PRICE_CENTS.starter);
  });

  it("returns 0 for suspended businesses even on Starter", () => {
    expect(
      suggestedCatalogExpectedCents({
        planCode: "starter",
        business: { status: "suspended", active: false },
      })
    ).toBe(0);
  });

  it("returns 0 for archived and legacy inactive businesses", () => {
    expect(
      suggestedCatalogExpectedCents({
        planCode: "starter",
        business: { status: "archived", active: false },
      })
    ).toBe(0);
    expect(
      suggestedCatalogExpectedCents({
        planCode: "starter",
        business: { active: false },
      })
    ).toBe(0);
  });
});

describe("resolveLedgerAmountsCents", () => {
  it("active Starter without a payment record → ₹1,999 expected and outstanding", () => {
    const amounts = resolveLedgerAmountsCents({
      planCode: "starter",
      business: { status: "active", active: true },
      payment: null,
    });
    expect(amounts.expectedCents).toBe(199_900);
    expect(amounts.receivedCents).toBe(0);
    expect(amounts.outstandingCents).toBe(199_900);
    expect(amounts.paymentRecorded).toBe(false);
    expect(String(amounts.expectedCents / 100)).toBe("1999");
  });

  it("suspended Starter without a payment record → ₹0 expected and outstanding", () => {
    const amounts = resolveLedgerAmountsCents({
      planCode: "starter",
      business: { status: "suspended", active: false },
      payment: null,
    });
    expect(amounts.expectedCents).toBe(0);
    expect(amounts.outstandingCents).toBe(0);
    expect(amounts.suggestedCatalogCents).toBe(0);
    expect(String(amounts.expectedCents / 100)).toBe("0");
  });

  it("suspended business with a saved payment record → persisted amounts win", () => {
    const amounts = resolveLedgerAmountsCents({
      planCode: "starter",
      business: { status: "suspended", active: false },
      payment: {
        amountExpectedCents: 199_900,
        amountReceivedCents: 50_000,
      },
    });
    expect(amounts.paymentRecorded).toBe(true);
    expect(amounts.expectedCents).toBe(199_900);
    expect(amounts.receivedCents).toBe(50_000);
    expect(amounts.outstandingCents).toBe(149_900);
    expect(amounts.suggestedCatalogCents).toBe(0);
  });
});
