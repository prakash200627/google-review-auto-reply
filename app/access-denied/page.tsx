import Link from "next/link";
import { redirect } from "next/navigation";
import {
  isAuthUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import { homePathForRole } from "@/lib/auth/homePath";

export const dynamic = "force-dynamic";

/**
 * Role-aware denial landing for authenticated users who hit a Super Admin–only
 * page. Does not render admin content. Signed-out visitors are sent to login.
 */
export default async function AccessDeniedPage() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) redirect("/login");

  const home = homePathForRole(auth.user.role);

  return (
    <main className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center gap-4 px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Access denied
      </h1>
      <p className="text-sm leading-relaxed text-zinc-600">
        Your account is signed in, but this area is limited to Super Admins.
        Business Admins use the ORM and GMB workspaces for assigned businesses
        only.
      </p>
      <p className="text-sm text-zinc-600">
        If you need organization, Google connection, or location-assignment
        changes, contact a Super Admin.
      </p>
      <div className="flex flex-wrap gap-3 pt-2">
        <Link
          href={home}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Go to workspace
        </Link>
        <Link
          href="/account"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
        >
          Account
        </Link>
      </div>
    </main>
  );
}
