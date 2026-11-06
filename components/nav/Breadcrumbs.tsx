import Link from "next/link";

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

/** Simple trail for nested workspace pages (GMB location detail, create, etc.). */
export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="text-sm text-zinc-600">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && (
                <span className="text-zinc-400" aria-hidden>
                  /
                </span>
              )}
              {item.href && !last ? (
                <Link href={item.href} className="underline hover:text-zinc-900">
                  {item.label}
                </Link>
              ) : (
                <span
                  className={last ? "font-medium text-zinc-800" : undefined}
                  aria-current={last ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
