import { redirect } from "next/navigation";
import {
  isAuthUser,
  requireAuthUser,
  type AuthUser,
} from "@/lib/auth/authorize";

/** Path for authenticated users who lack Super Admin page access. */
export const ACCESS_DENIED_PATH = "/access-denied";

/** Require any signed-in TRONX user (email/password session). */
export async function requirePageUser(): Promise<AuthUser> {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) redirect("/login");
  return auth.user;
}

/**
 * Require Super Admin for App Router pages.
 * - Signed-out → /login
 * - Authenticated non–Super Admin → /access-denied (no admin content rendered)
 * - Super Admin → continues
 *
 * Do not use requireSuperAdmin()'s JSON response here: treating 403 like
 * "no user" incorrectly sent Business Admins to /login.
 */
export async function requirePageSuperAdmin(): Promise<AuthUser> {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) redirect("/login");
  if (auth.user.role !== "superadmin") {
    redirect(ACCESS_DENIED_PATH);
  }
  return auth.user;
}
