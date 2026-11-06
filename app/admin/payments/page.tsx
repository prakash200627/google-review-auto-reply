import Link from "next/link";
import { AdminPaymentsPanel } from "@/components/AdminPaymentsPanel";
import { requirePageSuperAdmin } from "@/lib/auth/requirePageAuth";
import { resolveLedgerAmountsCents } from "@/lib/billing/planAmounts";
import { resolveBusinessLifecycle } from "@/lib/business/lifecycle";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { ManualPayment } from "@/models/ManualPayment";

export const dynamic = "force-dynamic";

function periodKeyNow(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function AdminPaymentsPage() {
  await requirePageSuperAdmin();

  const periodKey = periodKeyNow();
  await connectToDatabase();
  const [businesses, payments] = await Promise.all([
    Business.find({})
      .sort({ name: 1 })
      .select("name plan active status")
      .lean(),
    ManualPayment.find({ periodKey }).lean(),
  ]);
  const byBiz = new Map(payments.map((p) => [String(p.businessId), p]));

  const rows = businesses.map((b) => {
    const plan = toPlanSnapshot(b.plan as never);
    const payment = byBiz.get(String(b._id));
    const amounts = resolveLedgerAmountsCents({
      planCode: plan.code,
      business: b,
      payment,
    });
    return {
      businessId: String(b._id),
      name: b.name,
      planDisplayName: plan.displayName,
      planCode: plan.code,
      lifecycleStatus: resolveBusinessLifecycle(b),
      expectedCents: amounts.expectedCents,
      receivedCents: amounts.receivedCents,
      outstandingCents: amounts.outstandingCents,
      status: payment?.status || "not_recorded",
      paymentRecorded: amounts.paymentRecorded,
      listPriceCents: amounts.suggestedCatalogCents,
    };
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-700">
        Ledger for period <span className="font-medium">{periodKey}</span>. No
        payment gateway — record amounts only.{" "}
        <Link href="/admin/businesses" className="underline">
          Businesses
        </Link>
      </p>
      <AdminPaymentsPanel periodKey={periodKey} initialRows={rows} />
    </div>
  );
}
