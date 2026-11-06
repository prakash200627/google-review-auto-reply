import Link from "next/link";
import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/nav/Breadcrumbs";
import { OrmMetricGrid } from "@/components/orm/OrmMetricGrid";
import { RatingDistribution } from "@/components/orm/RatingDistribution";
import { RecentReviewsList } from "@/components/orm/RecentReviewsList";
import { OwnerBusinessPanel } from "@/components/OwnerBusinessPanel";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";
import { getBusinessOrmDashboard } from "@/lib/dashboard/ormDashboard";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ businessId: string }>;
};

export default async function BusinessOrmDashboardPage({ params }: PageProps) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) redirect("/login");

  const { businessId } = await params;
  const result = await getBusinessOrmDashboard(auth.user, businessId);

  if (!result.ok) {
    if (result.status === 404) {
      return (
        <div className="space-y-3">
          <Breadcrumbs
            items={[
              { label: "ORM", href: "/orm" },
              { label: "Business" },
            ]}
          />
          <p className="text-sm text-zinc-700">Business not found.</p>
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
              { label: "Business" },
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
          { label: data.business.name },
        ]}
      />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
            {data.business.name}
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Status:{" "}
            <span className="font-medium text-zinc-800">
              {data.business.status}
            </span>
            {data.business.groupName
              ? ` · Group: ${data.business.groupName}`
              : ""}
          </p>
          <p className="mt-1 text-sm text-zinc-600">
            Metrics from stored reviews for this business only.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link
            href={data.reviewsHref}
            className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white hover:bg-zinc-800"
          >
            Open Reviews
          </Link>
          {data.business.groupId && (
            <Link
              href={`/orm/group/${encodeURIComponent(data.business.groupId)}`}
              className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50"
            >
              Group dashboard
            </Link>
          )}
        </div>
      </header>

      <OrmMetricGrid
        loaded
        metrics={[
          { label: "Total reviews", value: data.metrics.totalReviews },
          {
            label: "Average rating",
            value:
              data.metrics.averageRating != null
                ? data.metrics.averageRating.toFixed(1)
                : "—",
          },
          { label: "Unanswered", value: data.metrics.unanswered },
          { label: "Drafts pending", value: data.metrics.draftsPending },
          { label: "Published replies", value: data.metrics.publishedReplies },
          { label: "Locations", value: data.metrics.locationCount },
        ]}
      />

      <section className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
        <h3 className="text-sm font-semibold text-zinc-900">Reply performance</h3>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>
            TRONX-confirmed publishes:{" "}
            <span className="font-medium text-zinc-800">
              {data.metrics.tronxPublished}
            </span>
          </li>
          <li>
            Google-synced replies (not TRONX publish):{" "}
            <span className="font-medium text-zinc-800">
              {data.metrics.googleSyncedReplies}
            </span>
          </li>
          <li>
            Failed publish attempts (stored error):{" "}
            <span className="font-medium text-zinc-800">
              {data.metrics.failedReplies}
            </span>
          </li>
        </ul>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <RatingDistribution buckets={data.ratingDistribution} />
        <section className="rounded-md border border-zinc-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-zinc-900">
            Reviews by location
          </h3>
          {data.byLocation.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-600">
              No locations assigned to this business.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-100 text-sm">
              {data.byLocation.map((loc) => (
                <li
                  key={loc.locationId}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                >
                  <span className="font-medium text-zinc-900">{loc.title}</span>
                  <span className="text-zinc-600">
                    {loc.reviewCount} reviews · {loc.unanswered} unanswered
                    {loc.averageRating != null
                      ? ` · avg ${loc.averageRating.toFixed(1)}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <RecentReviewsList
        reviews={data.recentReviews}
        reviewsHref={data.reviewsHref}
      />

      <OwnerBusinessPanel
        businessId={data.business.id}
        initialName={data.business.name}
        initialBrandVoice={data.business.brandVoice}
        initialLanguage={data.business.preferredLanguage}
        initialToneNotes={data.business.replyToneNotes}
        initialPhone={data.business.phone}
        replyMode={data.business.replyMode}
      />
    </div>
  );
}
