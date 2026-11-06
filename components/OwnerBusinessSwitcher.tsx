import Link from "next/link";

/** Simple multi-business links for owner workspace pages. */
export function OwnerBusinessSwitcher({
  businesses,
  currentBusinessId,
  basePath,
}: {
  businesses: Array<{ id: string; name: string }>;
  currentBusinessId: string | null;
  basePath: string;
}) {
  if (businesses.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      <span className="text-zinc-500">Business:</span>
      {businesses.map((b) => (
        <Link
          key={b.id}
          href={`${basePath}?businessId=${encodeURIComponent(b.id)}`}
          className={
            b.id === currentBusinessId
              ? "font-semibold text-zinc-900 underline"
              : "text-zinc-700 underline-offset-2 hover:underline"
          }
        >
          {b.name}
        </Link>
      ))}
    </div>
  );
}
