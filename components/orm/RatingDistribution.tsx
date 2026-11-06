import type { RatingBucket } from "@/lib/dashboard/ormDashboard";

export function RatingDistribution({
  buckets,
}: {
  buckets: RatingBucket[];
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-zinc-900">Rating distribution</h3>
      <ul className="mt-3 space-y-2">
        {buckets.map((b) => (
          <li key={b.stars} className="flex items-center gap-3 text-sm">
            <span className="w-8 tabular-nums text-zinc-600">{b.stars}★</span>
            <div className="h-2 flex-1 rounded bg-zinc-100">
              <div
                className="h-2 rounded bg-zinc-800"
                style={{ width: `${(b.count / max) * 100}%` }}
              />
            </div>
            <span className="w-10 text-right tabular-nums text-zinc-700">
              {b.count}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
