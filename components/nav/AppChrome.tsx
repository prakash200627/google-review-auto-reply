"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuthNav } from "@/components/auth/AuthNavProvider";
import {
  guestNavItems,
  isPrimaryNavActive,
  isSecondaryNavActive,
  loadingSafeNavItems,
  moduleSecondaryItems,
  moduleSwitcherItems,
  navLinkActiveClass,
  navLinkBaseClass,
  navLinkInactiveClass,
  type NavItem,
  type NavModule,
} from "@/components/nav/navConfig";

function NavLinks({
  items,
  ariaLabel,
  activeKind,
}: {
  items: NavItem[];
  ariaLabel: string;
  activeKind: "primary" | "secondary";
}) {
  const pathname = usePathname() || "/";

  return (
    <nav className="flex flex-wrap gap-2 text-sm sm:gap-3" aria-label={ariaLabel}>
      {items.map((item) => {
        const active =
          activeKind === "primary"
            ? isPrimaryNavActive(pathname, item.href)
            : isSecondaryNavActive(pathname, item.href, items);
        return (
          <Link
            key={`${item.href}:${item.label}`}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`${navLinkBaseClass} ${
              active ? navLinkActiveClass : navLinkInactiveClass
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

const MODULE_TITLES: Record<Exclude<NavModule, "none">, string> = {
  orm: "ORM",
  gmb: "GMB",
  admin: "Admin",
  account: "Account",
};

/**
 * Shared application chrome for ORM / GMB / Admin / Account and standalone pages.
 * Nav links are UX only; API/page auth remains authoritative.
 */
export function AppChrome({
  module = "none",
  children,
  title,
  breadcrumbs,
}: {
  module?: NavModule;
  children: ReactNode;
  title?: string;
  breadcrumbs?: ReactNode;
}) {
  const { status, user, error } = useAuthNav();

  let primary: NavItem[] = [];
  let secondary: NavItem[] = [];

  if (status === "loading") {
    primary = loadingSafeNavItems();
  } else if (status === "guest" || !user) {
    primary = guestNavItems();
  } else {
    primary = [
      ...moduleSwitcherItems(user.role),
      { href: "/account", label: "Account" },
    ];
    if (module !== "none") {
      secondary = moduleSecondaryItems(module, user.role);
    }
  }

  const heading =
    title ??
    (module !== "none" ? MODULE_TITLES[module] : "Review Auto-Reply");

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                TRONX
              </p>
              <h1 className="text-lg font-semibold tracking-tight">{heading}</h1>
            </div>
            <div className="flex flex-col items-end gap-1">
              <NavLinks items={primary} ariaLabel="Primary" activeKind="primary" />
              {status === "loading" && (
                <p className="text-xs text-zinc-400" role="status">
                  Checking session…
                </p>
              )}
              {status === "guest" && error && (
                <p className="text-xs text-amber-700" role="status">
                  Session check timed out or failed. Sign in to continue.
                </p>
              )}
            </div>
          </div>
          {secondary.length > 0 && (
            <NavLinks
              items={secondary}
              ariaLabel={`${module} module`}
              activeKind="secondary"
            />
          )}
          {breadcrumbs ? (
            <div className="text-sm text-zinc-600">{breadcrumbs}</div>
          ) : null}
        </div>
        {user?.role === "business_owner" && (
          <p className="sr-only">Signed in as a Business Admin</p>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
