import type { UserRole } from "@/models/User";

/** Post-login / already-authenticated landing path by role. */
export function homePathForRole(role: UserRole | string | undefined): string {
  if (role === "superadmin") return "/admin/dashboard";
  return "/orm";
}

/**
 * Legacy path → current canonical path.
 * Used by thin redirect pages so bookmarks keep working.
 * Note: /admin/groups is a real Admin page (not redirected).
 */
export const LEGACY_ROUTE_REDIRECTS: Record<string, string> = {
  "/dashboard": "/orm",
  "/reviews": "/orm/reviews",
  "/settings/google": "/gmb",
};

export function resolveLegacyRedirect(
  pathname: string,
  search = ""
): string | null {
  const target = LEGACY_ROUTE_REDIRECTS[pathname];
  if (!target) return null;
  return `${target}${search || ""}`;
}
