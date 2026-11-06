import type { PlanCode } from "@/lib/entitlements/plans";
import {
  isBusinessOperationallyActive,
  type BusinessLifecycleFields,
} from "@/lib/business/lifecycle";

/**
 * Catalog list prices for Super Admin dashboards (manual billing only).
 * Not charged automatically. Cents in INR for display consistency.
 */
export const PLAN_LIST_PRICE_CENTS: Record<PlanCode, number> = {
  free: 0,
  starter: 199900,
  growth: 499900,
  custom: 0,
};

export function listPriceCentsForPlan(code: string | undefined): number {
  if (
    code === "free" ||
    code === "starter" ||
    code === "growth" ||
    code === "custom"
  ) {
    return PLAN_LIST_PRICE_CENTS[code];
  }
  return 0;
}

/**
 * Suggested catalog expected amount when no ManualPayment row exists.
 * Active businesses only — suspended / archived / inactive seed ₹0.
 */
export function suggestedCatalogExpectedCents(input: {
  planCode: string | undefined;
  business: BusinessLifecycleFields | null | undefined;
}): number {
  if (!isBusinessOperationallyActive(input.business)) return 0;
  return listPriceCentsForPlan(input.planCode);
}

type PaymentExpectedFields = {
  amountExpectedCents?: number | null;
  amountReceivedCents?: number | null;
};

/**
 * Ledger expected amount: persisted ManualPayment always wins when present;
 * otherwise suggested catalog (active-only).
 */
export function resolveLedgerAmountsCents(input: {
  planCode: string | undefined;
  business: BusinessLifecycleFields | null | undefined;
  payment?: PaymentExpectedFields | null;
}): {
  expectedCents: number;
  receivedCents: number;
  outstandingCents: number;
  suggestedCatalogCents: number;
  paymentRecorded: boolean;
} {
  const suggestedCatalogCents = suggestedCatalogExpectedCents({
    planCode: input.planCode,
    business: input.business,
  });
  const paymentRecorded = Boolean(input.payment);
  const expectedCents = paymentRecorded
    ? Math.max(0, Math.floor(Number(input.payment?.amountExpectedCents) || 0))
    : suggestedCatalogCents;
  const receivedCents = paymentRecorded
    ? Math.max(0, Math.floor(Number(input.payment?.amountReceivedCents) || 0))
    : 0;
  return {
    expectedCents,
    receivedCents,
    outstandingCents: Math.max(0, expectedCents - receivedCents),
    suggestedCatalogCents,
    paymentRecorded,
  };
}

export function formatInrFromCents(cents: number): string {
  const rupees = (Math.max(0, cents) / 100).toFixed(0);
  return `₹${Number(rupees).toLocaleString("en-IN")}`;
}
