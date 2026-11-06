import Link from "next/link";
import type { RecentReviewRow } from "@/lib/dashboard/ormDashboard";

export function RecentReviewsList({
  reviews,
  reviewsHref,
}: {
  reviews: RecentReviewRow[];
  reviewsHref: string;
}) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">Recent reviews</h3>
        <Link href={reviewsHref} className="text-xs underline text-zinc-600">
          Open Reviews workspace
        </Link>
      </div>
      {reviews.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-600">No stored reviews in this scope.</p>
      ) : (
        <ul className="mt-3 divide-y divide-zinc-100">
          {reviews.map((r) => (
            <li key={r.id} className="py-2">
              <p className="text-sm font-medium text-zinc-900">
                {r.reviewerDisplayName}
                {r.starRating != null ? ` · ${r.starRating}★` : ""}
                {r.hasReply ? " · replied" : " · unanswered"}
              </p>
              <p className="mt-0.5 line-clamp-2 text-sm text-zinc-700">
                {r.comment || "(no comment)"}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {r.locationTitle || "Location"}
                {r.businessName ? ` · ${r.businessName}` : ""}
                {r.createTime
                  ? ` · ${new Date(r.createTime).toLocaleDateString()}`
                  : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
