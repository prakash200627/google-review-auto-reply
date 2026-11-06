import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  assertBusinessAccess,
  isAuthUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import {
  assertLifecycleAllowsAction,
  operationalGuardResponse,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import {
  listPriceCentsForPlan,
  resolveLedgerAmountsCents,
} from "@/lib/billing/planAmounts";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import { ManualPayment } from "@/models/ManualPayment";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

function periodKeyNow(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Owner read-only billing view for their business (manual ledger). */
export async function GET(request: Request, context: RouteContext) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;

  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }

  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  try {
    assertLifecycleAllowsAction(access.business, "read_billing");
  } catch (err) {
    if (err instanceof OperationalGuardError) {
      return operationalGuardResponse(err);
    }
    throw err;
  }

  const { searchParams } = new URL(request.url);
  const periodKey =
    String(searchParams.get("periodKey") || "").trim() || periodKeyNow();

  await connectToDatabase();
  const plan = toPlanSnapshot(access.business.plan as never);
  const payment = await ManualPayment.findOne({ businessId, periodKey }).lean();
  const amounts = resolveLedgerAmountsCents({
    planCode: plan.code,
    business: access.business,
    payment,
  });
  const status = payment?.status || "not_recorded";
  const overdue =
    status === "overdue" ||
    (status !== "received" &&
      status !== "waived" &&
      !payment &&
      amounts.outstandingCents > 0 &&
      periodKey < periodKeyNow());

  return NextResponse.json({
    success: true,
    periodKey,
    plan: { code: plan.code, displayName: plan.displayName, status: plan.status },
    amounts: {
      expectedCents: amounts.expectedCents,
      receivedCents: amounts.receivedCents,
      outstandingCents: amounts.outstandingCents,
      overdueCents: overdue ? amounts.outstandingCents : 0,
      listPriceEstimateCents: listPriceCentsForPlan(plan.code),
      suggestedCatalogCents: amounts.suggestedCatalogCents,
      paymentRecorded: amounts.paymentRecorded,
      status,
    },
    note: "Manual ledger only. Received amounts require a payment record. Suggested catalog expected applies to active businesses only when no payment row exists.",
  });
}
