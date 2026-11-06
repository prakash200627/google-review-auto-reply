export type OrmMetric = { label: string; value: string | number };

export function OrmMetricGrid({
  metrics,
  loaded,
}: {
  metrics: OrmMetric[] | null;
  loaded: boolean;
}) {
  if (!loaded) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-hidden>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-md border border-zinc-200 bg-zinc-100"
          />
        ))}
      </div>
    );
  }
  if (!metrics) return null;

  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {metrics.map((m) => (
        <div
          key={m.label}
          className="rounded-md border border-zinc-200 bg-white px-3 py-2"
        >
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            {m.label}
          </p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900">
            {m.value}
          </p>
        </div>
      ))}
    </section>
  );
}
