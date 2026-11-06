import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import {
  assertBusinessAccess,
  isAuthUser,
  listActiveBusinessIdsForUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import { OwnerBusinessSwitcher } from "@/components/OwnerBusinessSwitcher";
import { resolveOwnerBusinessId } from "@/lib/business/ownerWorkspace";
import {
  buildMonthlyReport,
  currentPeriodKey,
} from "@/lib/reports/monthly";
import {
  assertBusinessOperationAllowed,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import { EntitlementError } from "@/lib/entitlements/enforce";
import { Business } from "@/models/Business";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ businessId?: string; periodKey?: string }>;
};

export default async function ReportsPage({ searchParams }: PageProps) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) redirect("/login");
  if (auth.user.role === "superadmin") {
    redirect("/admin/dashboard");
  }

  const params = (await searchParams) || {};
  const businessId = await resolveOwnerBusinessId(
    auth.user,
    typeof params.businessId === "string" ? params.businessId : null
  );
  const periodKey =
    typeof params.periodKey === "string" && params.periodKey
      ? params.periodKey
      : currentPeriodKey();
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
  let report = null;

  if (!businessId) {
    error = "No active business is assigned to your account.";
  } else {
    const access = await assertBusinessAccess(auth.user, businessId);
    if (!access.ok) {
      error = "You do not have access to this business.";
    } else {
      try {
        await assertBusinessOperationAllowed({
          businessId,
          business: access.business,
          action: "read_reports",
        });
        report = await buildMonthlyReport({ businessId, periodKey });
      } catch (err) {
        if (err instanceof OperationalGuardError || err instanceof EntitlementError) {
          error = err.message;
        } else {
          error = "Could not load report.";
        }
      }
    }
  }

  return (
    <AppShell title="Monthly reports" module="orm">
      <div className="space-y-4">
        <p className="text-sm text-zinc-700">
          Business-scoped metrics for {periodKey}. Metrics use stored data only
          — unavailable history is not invented.{" "}
          <Link href="/orm" className="underline">
            Dashboard
          </Link>
        </p>
        <OwnerBusinessSwitcher
          businesses={businessChoices}
          currentBusinessId={businessId}
          basePath="/reports"
        />
        {error && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            {error}
          </p>
        )}
        {report && (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                ["Reviews in period", report.reviewCount],
                [
                  "Average rating",
                  report.averageRating != null
                    ? report.averageRating.toFixed(1)
                    : "Unavailable",
                ],
                ["TRONX published", report.tronxPublishedReplies],
                ["Google-synced replies", report.googleSyncedReplies],
                ["Drafts generated", report.draftsGenerated],
                ["Drafts approved", report.draftsApproved],
                ["Failed publishes", report.failedPublishes],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
              >
                <p className="text-sm text-zinc-500">{label}</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {value}
                </p>
              </div>
            ))}
          </section>
        )}
        {report?.notes?.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </AppShell>
  );
}
