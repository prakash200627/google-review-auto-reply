import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import {
  assertBusinessAccess,
  isAuthUser,
  listActiveBusinessIdsForUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import {
  assertLifecycleAllowsAction,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import {
  formatInrFromCents,
  listPriceCentsForPlan,
  resolveLedgerAmountsCents,
} from "@/lib/billing/planAmounts";
import { OwnerBusinessSwitcher } from "@/components/OwnerBusinessSwitcher";
import { resolveOwnerBusinessId } from "@/lib/business/ownerWorkspace";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { ManualPayment } from "@/models/ManualPayment";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ businessId?: string; periodKey?: string }>;
};

function periodKeyNow(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function BillingPage({ searchParams }: PageProps) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) redirect("/login");
  if (auth.user.role === "superadmin") {
    redirect("/admin/payments");
  }

  const params = (await searchParams) || {};
  const businessId = await resolveOwnerBusinessId(
    auth.user,
    typeof params.businessId === "string" ? params.businessId : null
  );
  const periodKey =
    typeof params.periodKey === "string" && params.periodKey
      ? params.periodKey
      : periodKeyNow();
  const activeIds = await listActiveBusinessIdsForUser(auth.user);
  const businessChoices =
    activeIds.length > 1
      ? (
          await Business.find({ _id: { $in: activeIds } })
            .select("name")
            .lean()
        ).map((b) => ({ id: String(b._id), name: b.name || "Business" }))
      : [];

  let error: string | null = null;
  let view: {
    planName: string;
    planStatus: string;
    expected: number;
    received: number;
    outstanding: number;
    overdue: number;
    status: string;
    recorded: boolean;
    listPrice: number;
  } | null = null;

  if (!businessId) {
    error = "No active business is assigned to your account.";
  } else {
    const access = await assertBusinessAccess(auth.user, businessId);
    if (!access.ok) {
      error = "You do not have access to this business.";
    } else {
      try {
        assertLifecycleAllowsAction(access.business, "read_billing");
        await connectToDatabase();
        const plan = toPlanSnapshot(access.business.plan as never);
        const payment = await ManualPayment.findOne({
          businessId,
          periodKey,
        }).lean();
        const amounts = resolveLedgerAmountsCents({
          planCode: plan.code,
          business: access.business,
          payment,
        });
        const status = payment?.status || "not_recorded";
        const overdue =
          status === "overdue"
            ? amounts.outstandingCents
            : status !== "received" &&
                status !== "waived" &&
                !payment &&
                periodKey < periodKeyNow()
              ? amounts.outstandingCents
              : 0;
        view = {
          planName: plan.displayName,
          planStatus: plan.status,
          expected: amounts.expectedCents,
          received: amounts.receivedCents,
          outstanding: amounts.outstandingCents,
          overdue,
          status,
          recorded: amounts.paymentRecorded,
          // Full plan catalog list price (reference); suggested period amount may be 0 when inactive.
          listPrice: listPriceCentsForPlan(plan.code),
        };
      } catch (err) {
        if (err instanceof OperationalGuardError) {
          error = err.message;
        } else {
          error = "Could not load billing.";
        }
      }
    }
  }

  return (
    <AppShell title="Billing" module="orm">
      <div className="space-y-4">
        <p className="text-sm text-zinc-700">
          Manual payment ledger for {periodKey}. Received amounts require a
          payment record.{" "}
          <Link href="/orm" className="underline">
            Dashboard
          </Link>
        </p>
        <OwnerBusinessSwitcher
          businesses={businessChoices}
          currentBusinessId={businessId}
          basePath="/billing"
        />
        {error && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            {error}
          </p>
        )}
        {view && (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                ["Plan", `${view.planName} (${view.planStatus})`],
                ["Expected", formatInrFromCents(view.expected)],
                ["Received", formatInrFromCents(view.received)],
                ["Outstanding", formatInrFromCents(view.outstanding)],
                ["Overdue", formatInrFromCents(view.overdue)],
                [
                  "Payment record",
                  view.recorded ? view.status : "Not recorded",
                ],
                [
                  "List-price estimate",
                  formatInrFromCents(view.listPrice),
                ],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
              >
                <p className="text-sm text-zinc-500">{label}</p>
                <p className="mt-2 text-lg font-semibold text-zinc-900">
                  {value}
                </p>
              </div>
            ))}
          </section>
        )}
      </div>
    </AppShell>
  );
}
