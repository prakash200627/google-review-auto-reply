import Link from "next/link";
import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/nav/Breadcrumbs";
import { OrmMetricGrid } from "@/components/orm/OrmMetricGrid";
import { RatingDistribution } from "@/components/orm/RatingDistribution";
import { RecentReviewsList } from "@/components/orm/RecentReviewsList";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";
import { getGroupOrmDashboard } from "@/lib/dashboard/ormDashboard";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ groupId: string }>;
};

export default async function GroupOrmDashboardPage({ params }: PageProps) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) redirect("/login");

  const { groupId } = await params;
  const result = await getGroupOrmDashboard(auth.user, groupId);

  if (!result.ok) {
    if (result.status === 404) {
      return (
        <div className="space-y-3">
          <Breadcrumbs
            items={[
              { label: "ORM", href: "/orm" },
              { label: "Group" },
            ]}
          />
          <p className="text-sm text-zinc-700">Group not found.</p>
          <Link href="/orm" className="text-sm underline">
            Back to ORM overview
          </Link>
        </div>
      );
    }
    if (
      result.status === 403 &&
      (result.code === "org_mismatch" || result.code === "org_required")
    ) {
      return (
        <div className="space-y-3">
          <Breadcrumbs
            items={[
              { label: "ORM", href: "/orm" },
              { label: "Group" },
            ]}
          />
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {result.message}
          </p>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link href="/orm" className="underline">
              Back to ORM overview
            </Link>
            <Link href="/admin/businesses" className="underline">
              Select organization
            </Link>
          </div>
        </div>
      );
    }
    if (result.status === 403) {
      redirect("/access-denied");
    }
    return (
      <div className="space-y-3">
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {result.message}
        </p>
        <Link href="/orm" className="text-sm underline">
          Back to ORM overview
        </Link>
      </div>
    );
  }

  const { data } = result;

  return (
    <div className="space-y-5">
      <Breadcrumbs
        items={[
          { label: "ORM", href: "/orm" },
          { label: data.group.name },
        ]}
      />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
            {data.group.name}
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Status:{" "}
            <span className="font-medium text-zinc-800">
              {data.group.active ? "active" : "inactive"}
            </span>
            {data.group.description ? ` · ${data.group.description}` : ""}
          </p>
          <p className="mt-1 text-sm text-zinc-600">
            Aggregated across authorized member businesses only (Business.groupId
            ∩ your access).
          </p>
        </div>
        <Link
          href={data.reviewsHref}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Open Reviews
        </Link>
      </header>

      <OrmMetricGrid
        loaded
        metrics={[
          { label: "Businesses", value: data.metrics.businessCount },
          { label: "Total reviews", value: data.metrics.totalReviews },
          {
            label: "Combined rating",
            value:
              data.metrics.averageRating != null
                ? data.metrics.averageRating.toFixed(1)
                : "—",
          },
          { label: "Unanswered", value: data.metrics.unanswered },
          { label: "Pending drafts", value: data.metrics.draftsPending },
          { label: "Published replies", value: data.metrics.publishedReplies },
          { label: "Locations", value: data.metrics.locationCount },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <RatingDistribution buckets={data.ratingDistribution} />
        <section className="rounded-md border border-zinc-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-zinc-900">
            Member locations
          </h3>
          {data.locations.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-600">
              No locations on authorized member businesses.
            </p>
          ) : (
            <ul className="mt-3 max-h-64 divide-y divide-zinc-100 overflow-y-auto text-sm">
              {data.locations.map((loc) => (
                <li key={loc.locationId} className="py-2">
                  <span className="font-medium text-zinc-900">{loc.title}</span>
                  {loc.businessName ? (
                    <span className="text-zinc-600"> · {loc.businessName}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-zinc-900">
          Per-business comparison
        </h3>
        {data.businesses.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-600">
            This group has no authorized member businesses for your account.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-3 font-medium">Business</th>
                  <th className="py-2 pr-3 font-medium">Reviews</th>
                  <th className="py-2 pr-3 font-medium">Avg</th>
                  <th className="py-2 pr-3 font-medium">Unanswered</th>
                  <th className="py-2 pr-3 font-medium">Drafts</th>
                  <th className="py-2 font-medium">Published</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {data.businesses.map((b) => (
                  <tr key={b.businessId}>
                    <td className="py-2 pr-3">
                      <Link
                        href={`/orm/business/${encodeURIComponent(b.businessId)}`}
                        className="font-medium text-zinc-900 underline-offset-2 hover:underline"
                      >
                        {b.name}
                      </Link>
                      <span className="ml-1 text-xs text-zinc-500">
                        ({b.status})
                      </span>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{b.totalReviews}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {b.averageRating != null
                        ? b.averageRating.toFixed(1)
                        : "—"}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{b.unanswered}</td>
                    <td className="py-2 pr-3 tabular-nums">{b.draftsPending}</td>
                    <td className="py-2 tabular-nums">{b.publishedReplies}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <RecentReviewsList
        reviews={data.recentReviews}
        reviewsHref={data.reviewsHref}
      />
    </div>
  );
}
