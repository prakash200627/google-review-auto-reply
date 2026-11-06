import Link from "next/link";
import { requirePageSuperAdmin } from "@/lib/auth/requirePageAuth";
import { formatInrFromCents } from "@/lib/billing/planAmounts";
import { getPlatformDashboardStats } from "@/lib/business/platformStats";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const user = await requirePageSuperAdmin();

  let stats = null;
  let error: string | null = null;
  try {
    stats = await getPlatformDashboardStats();
  } catch {
    error = "Could not load Super Admin platform statistics.";
  }

  return (
      <div className="space-y-6">
        <section>
          <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
            Platform & subscriptions
          </h2>
          <p className="mt-1 text-sm text-zinc-700">
            Signed in as {user.email}. This dashboard tracks businesses,
            plans, Google connections, and manually recorded payments — not
            customer review content. Review operations belong on each business
            workspace.
          </p>
        </section>

        {error && (
          <p
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
            role="alert"
          >
            {error}
          </p>
        )}

        {stats && (
          <>
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["Registered businesses", stats.totalBusinesses],
                  ["Active", stats.activeBusinesses],
                  ["Inactive", stats.inactiveBusinesses],
                  ["Suspended plans", stats.suspendedPlans],
                  ["Expired plans", stats.expiredPlans],
                  ["Active owners", stats.ownersActive],
                  ["Inactive owners", stats.ownersInactive],
                  ["Active Google connections", stats.googleConnectionsActive],
                ] as const
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-lg border border-zinc-300 bg-white p-4 shadow-sm"
                >
                  <p className="text-sm font-medium text-zinc-700">{label}</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900">
                    {value}
                  </p>
                </div>
              ))}
            </section>

            <section className="rounded-lg border border-zinc-300 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-semibold tracking-tight text-zinc-900">
                Businesses by plan
              </h3>
              {stats.byPlan.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-700">No businesses yet.</p>
              ) : (
                <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {stats.byPlan.map((p) => (
                    <li
                      key={p.code}
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900"
                    >
                      <span className="font-medium">{p.displayName}</span>
                      <span className="ml-2 tabular-nums text-zinc-700">
                        {p.count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-zinc-300 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-semibold tracking-tight text-zinc-900">
                Subscription money (manual ledger)
              </h3>
              <p className="mt-1 text-sm text-zinc-700">
                Catalog expected MRR (active businesses):{" "}
                <span className="font-semibold text-zinc-900">
                  {stats.monthlyExpectedLabel}
                </span>
                . This is a list-price estimate, not collected cash.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                <div className="rounded-md border border-zinc-200 p-3">
                  <p className="font-medium text-zinc-700">
                    Period {stats.payments.periodKey} — recorded expected
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900">
                    {formatInrFromCents(stats.payments.expectedCents)}
                  </p>
                </div>
                <div className="rounded-md border border-zinc-200 p-3">
                  <p className="font-medium text-zinc-700">Recorded received</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900">
                    {formatInrFromCents(stats.payments.receivedCents)}
                  </p>
                </div>
                <div className="rounded-md border border-zinc-200 p-3">
                  <p className="font-medium text-zinc-700">Recorded overdue</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900">
                    {formatInrFromCents(stats.payments.overdueCents)}
                  </p>
                </div>
                <div className="rounded-md border border-zinc-200 p-3">
                  <p className="font-medium text-zinc-700">Ledger rows</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900">
                    {stats.payments.rowCount}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-sm text-zinc-800">
                {stats.payments.note}
              </p>
              {!stats.payments.configured && (
                <p className="mt-2 text-sm font-medium text-zinc-900">
                  Payment collection and historical payment data are not
                  configured yet. Use{" "}
                  <code className="rounded bg-zinc-100 px-1 text-xs">
                    ManualPayment
                  </code>{" "}
                  records (API) when you start logging amounts — no payment
                  provider is integrated.
                </p>
              )}
            </section>

            <section className="rounded-lg border border-zinc-300 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold tracking-tight text-zinc-900">
                  Businesses
                </h3>
                <Link
                  href="/admin/businesses"
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
                >
                  Manage businesses
                </Link>
              </div>
              {stats.businesses.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-700">
                  No businesses registered yet.
                </p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="border-b border-zinc-300 text-zinc-700">
                      <tr>
                        <th className="py-2 pr-4 font-semibold">Name</th>
                        <th className="py-2 pr-4 font-semibold">Status</th>
                        <th className="py-2 pr-4 font-semibold">Plan</th>
                        <th className="py-2 pr-4 font-semibold">Owner</th>
                        <th className="py-2 pr-4 font-semibold">Google</th>
                        <th className="py-2 pr-4 font-semibold">List price</th>
                        <th className="py-2 font-semibold">Open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.businesses.map((biz) => (
                        <tr
                          key={biz.id}
                          className="border-b border-zinc-200 align-top text-zinc-900"
                        >
                          <td className="py-3 pr-4 font-medium">{biz.name}</td>
                          <td className="py-3 pr-4">
                            {biz.active ? "Active" : "Inactive"}
                            {biz.planStatus !== "active"
                              ? ` · plan ${biz.planStatus}`
                              : ""}
                          </td>
                          <td className="py-3 pr-4">{biz.planName}</td>
                          <td className="py-3 pr-4">
                            {biz.ownerEmail
                              ? `${biz.ownerEmail}${
                                  biz.ownerActive === false
                                    ? " (inactive)"
                                    : ""
                                }`
                              : "—"}
                          </td>
                          <td className="py-3 pr-4">
                            {biz.googleConnected ? "Connected" : "Missing"}
                          </td>
                          <td className="py-3 pr-4 tabular-nums">
                            {formatInrFromCents(biz.listPriceCents)}
                          </td>
                          <td className="py-3">
                            <Link
                              href={`/orm?businessId=${encodeURIComponent(biz.id)}`}
                              className="font-medium text-zinc-900 underline"
                            >
                              Support view
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
  );
}
