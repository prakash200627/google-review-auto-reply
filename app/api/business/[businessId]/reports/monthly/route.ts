import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  assertBusinessAccess,
  isAuthUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import {
  assertBusinessOperationAllowed,
  operationalGuardResponse,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import {
  EntitlementError,
  entitlementErrorResponse,
} from "@/lib/entitlements/enforce";
import {
  buildMonthlyReport,
  currentPeriodKey,
} from "@/lib/reports/monthly";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

/** Owner/SA monthly report — entitlement maps monthlyReport → advancedAnalytics. */
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
    await assertBusinessOperationAllowed({
      businessId,
      business: access.business,
      action: "read_reports",
    });
  } catch (err) {
    if (err instanceof OperationalGuardError) {
      return operationalGuardResponse(err);
    }
    if (err instanceof EntitlementError) {
      return entitlementErrorResponse(err);
    }
    throw err;
  }

  const { searchParams } = new URL(request.url);
  const periodKey =
    String(searchParams.get("periodKey") || "").trim() || currentPeriodKey();

  const report = await buildMonthlyReport({ businessId, periodKey });
  if (!report) {
    return NextResponse.json(
      { success: false, message: "Invalid periodKey (use YYYY-MM)." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, report });
}
