"use client";

export default function GmbError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <p className="font-medium">GMB could not load this view.</p>
      <p>
        {error.message ||
          "Google or workspace data failed to load. ORM navigation stays available."}
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md border border-amber-300 bg-white px-3 py-1.5 hover:bg-amber-100"
      >
        Try again
      </button>
    </div>
  );
}
