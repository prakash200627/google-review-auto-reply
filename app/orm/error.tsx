"use client";

export default function OrmError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <p className="font-medium">ORM could not load this view.</p>
      <p className="text-red-800">
        {error.message || "An unexpected error occurred."}
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-red-900 hover:bg-red-100"
      >
        Try again
      </button>
    </div>
  );
}
