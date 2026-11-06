import type { AuthNavRole } from "@/components/auth/AuthNavProvider";

export type NavItem = { href: string; label: string };

export type NavModule = "orm" | "gmb" | "admin" | "account" | "none";

/** BA tool routes that live outside /orm but belong to the ORM workspace. */
export const ORM_TOOL_PATHS = [
  "/reports",
  "/seo",
  "/services",
  "/billing",
] as const;

/** Cross-module hubs — only after server-confirmed role is known. */
export function moduleSwitcherItems(role: AuthNavRole): NavItem[] {
  const items: NavItem[] = [
    { href: "/orm", label: "ORM" },
    { href: "/gmb", label: "GMB" },
  ];
  if (role === "superadmin") {
    items.push({ href: "/admin/dashboard", label: "Admin" });
  }
  return items;
}

export function moduleSecondaryItems(
  module: NavModule,
  role: AuthNavRole
): NavItem[] {
  if (module === "orm") {
    const items: NavItem[] = [
      { href: "/orm", label: "Overview" },
      { href: "/orm/reviews", label: "Reviews" },
    ];
    if (role === "business_owner") {
      items.push(
        { href: "/orm/groups", label: "Groups" },
        { href: "/reports", label: "Reports" },
        { href: "/seo", label: "SEO" },
        { href: "/services", label: "Services" },
        { href: "/billing", label: "Billing" }
      );
    }
    return items;
  }
  if (module === "gmb") {
    const items: NavItem[] = [
      { href: "/gmb", label: "Connection" },
      { href: "/gmb/locations", label: "Locations" },
    ];
    if (role === "superadmin") {
      items.push({ href: "/gmb/locations/create", label: "Create location" });
    }
    return items;
  }
  if (module === "admin") {
    if (role !== "superadmin") return [];
    return [
      { href: "/admin/dashboard", label: "Dashboard" },
      { href: "/admin/onboarding", label: "Onboarding" },
      { href: "/admin/businesses", label: "Businesses" },
      { href: "/admin/groups", label: "Groups" },
      { href: "/admin/payments", label: "Payments" },
      { href: "/admin/audit", label: "Audit" },
    ];
  }
  if (module === "account") {
    return [{ href: "/account", label: "Profile" }];
  }
  return [];
}

/**
 * Safe links while /api/auth/me is in flight — never Admin, never guest Sign in.
 * Showing Sign in during restore falsely implies the user is logged out.
 */
export function loadingSafeNavItems(): NavItem[] {
  return [];
}

/** Unauthenticated chrome — Sign in only; no protected workspace links. */
export function guestNavItems(): NavItem[] {
  return [{ href: "/login", label: "Sign in" }];
}

function pathMatchesHref(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Primary switcher active state: highlight the workspace that owns the path.
 */
export function isPrimaryNavActive(pathname: string, href: string): boolean {
  if (href === "/account") {
    return pathMatchesHref(pathname, "/account");
  }
  if (href === "/admin/dashboard" || href === "/admin") {
    return pathname === "/admin" || pathname.startsWith("/admin/");
  }
  if (href === "/gmb") {
    return pathMatchesHref(pathname, "/gmb");
  }
  if (href === "/orm") {
    if (pathMatchesHref(pathname, "/orm")) return true;
    return (ORM_TOOL_PATHS as readonly string[]).some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    );
  }
  return pathMatchesHref(pathname, href);
}

/**
 * Secondary nav: prefer the longest matching href so Overview (/orm) does not
 * stay active on /orm/reviews.
 */
export function isSecondaryNavActive(
  pathname: string,
  href: string,
  items: NavItem[]
): boolean {
  const matches = items.filter((item) => pathMatchesHref(pathname, item.href));
  if (matches.length === 0) return false;
  matches.sort((a, b) => b.href.length - a.href.length);
  return matches[0].href === href;
}

export const navLinkBaseClass =
  "rounded-md px-3 py-1.5 transition hover:bg-zinc-100 hover:text-zinc-900";

export const navLinkInactiveClass = "text-zinc-700";

export const navLinkActiveClass =
  "bg-zinc-900 text-white hover:bg-zinc-800 hover:text-white";
