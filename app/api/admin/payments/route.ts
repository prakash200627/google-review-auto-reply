import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { ManualPayment } from "@/models/ManualPayment";
import { listPriceCentsForPlan } from "@/lib/billing/planAmounts";
import {
  isPaymentStatus,
  PaymentValidationError,
  validateManualPaymentInput,
} from "@/lib/billing/paymentValidation";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";

export const runtime = "nodejs";

function periodKeyNow(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** List manually recorded payments for a period (default: current UTC month). */
export async function GET(request: Request) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const { searchParams } = new URL(request.url);
  const periodKey = String(searchParams.get("periodKey") || periodKeyNow());

  await connectToDatabase();
  const rows = await ManualPayment.find({ periodKey })
    .sort({ businessId: 1 })
    .lean();

  return NextResponse.json({
    success: true,
    periodKey,
    payments: rows.map((r) => ({
      id: String(r._id),
      businessId: String(r.businessId),
      periodKey: r.periodKey,
      amountExpectedCents: r.amountExpectedCents || 0,
      amountReceivedCents: r.amountReceivedCents || 0,
      currency: r.currency || "INR",
      status: r.status,
      notes: r.notes || "",
      recordedAt: r.recordedAt ? new Date(r.recordedAt).toISOString() : null,
    })),
    note: "Manual ledger only — no payment provider.",
  });
}

/**
 * Upsert a manual payment row. Does not charge cards or call processors.
 * Super Admin only.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  let body: {
    businessId?: unknown;
    periodKey?: unknown;
    amountExpectedCents?: unknown;
    amountReceivedCents?: unknown;
    status?: unknown;
    notes?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const businessId = String(body.businessId || "").trim();
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Valid businessId is required." },
      { status: 400 }
    );
  }

  const periodKey =
    typeof body.periodKey === "string" && /^\d{4}-\d{2}$/.test(body.periodKey)
      ? body.periodKey
      : periodKeyNow();

  const status = isPaymentStatus(body.status) ? body.status : "not_recorded";

  await connectToDatabase();
  const business = await Business.findById(businessId)
    .select("plan name")
    .lean();
  if (!business) {
    return NextResponse.json(
      { success: false, message: "Business not found." },
      { status: 404 }
    );
  }

  const plan = toPlanSnapshot(business.plan as never);
  const amountExpectedCents =
    typeof body.amountExpectedCents === "number"
      ? Math.max(0, Math.floor(body.amountExpectedCents))
      : listPriceCentsForPlan(plan.code);
  const amountReceivedCents =
    typeof body.amountReceivedCents === "number"
      ? Math.max(0, Math.floor(body.amountReceivedCents))
      : 0;

  const existing = await ManualPayment.findOne({ businessId, periodKey })
    .select("status")
    .lean();

  try {
    validateManualPaymentInput({
      status,
      amountExpectedCents,
      amountReceivedCents,
      previousStatus: existing?.status || null,
    });
  } catch (err) {
    if (err instanceof PaymentValidationError) {
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
      );
    }
    throw err;
  }

  const doc = await ManualPayment.findOneAndUpdate(
    { businessId, periodKey },
    {
      $set: {
        amountExpectedCents,
        amountReceivedCents,
        status,
        notes: typeof body.notes === "string" ? body.notes.slice(0, 500) : "",
        recordedByUserId: auth.user.userId,
        recordedAt: new Date(),
        currency: "INR",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "payment.manual_upsert",
    success: true,
    target: { businessId, periodKey, status },
  });

  return NextResponse.json({
    success: true,
    payment: {
      id: String(doc!._id),
      businessId,
      periodKey,
      amountExpectedCents,
      amountReceivedCents,
      status,
    },
    message: "Manual payment row saved. No payment provider was contacted.",
  });
}
