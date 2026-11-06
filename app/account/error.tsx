"use client";

export default function AccountError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-zinc-900">Account error</h2>
      <p className="text-sm text-zinc-600">
        Something went wrong loading your account. Try again.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
      >
        Retry
      </button>
    </div>
  );
}
