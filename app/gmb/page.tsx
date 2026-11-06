import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { GmbConnectionStatusSection } from "@/components/gmb/GmbConnectionStatusSection";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";

export const dynamic = "force-dynamic";

function GoogleStatusFallback() {
  return (
    <div
      className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-medium text-zinc-800">Google connection</p>
      <p className="mt-2 text-sm text-zinc-500">
        Loading connection status for this workspace… Module navigation and ORM
        stay available while this panel loads.
      </p>
    </div>
  );
}

/**
 * GMB module hub.
 * Shell (copy + cross-links) streams after a light auth check.
 * Slow Google status / org resolution runs inside Suspense via
 * GmbConnectionStatusSection — does not block ModuleShell or ORM nav.
 *
 * Super Admin manages the central TRONX Google connection (OAuth ≠ TRONX login).
 * Business Admins may view status; connect/disconnect stay SA-only in the panel.
 */
export default async function GmbHubPage() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    redirect("/login");
  }

  const isSuperAdmin = auth.user.role === "superadmin";

  return (
    <>
      <p className="mb-4 text-sm text-zinc-600">
        TRONX users sign in with email/password. This page manages the Google
        Business Profile integration only
        {isSuperAdmin
          ? " — Super Admin connects the central TRONX Google account."
          : " — Business Admins view status; only Super Admin can connect or reconnect Google."}
      </p>
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Link className="underline" href="/gmb/locations">
          Locations
        </Link>
        <Link className="underline" href="/orm/reviews">
          ORM reviews
        </Link>
      </div>
      <Suspense fallback={<GoogleStatusFallback />}>
        <GmbConnectionStatusSection />
      </Suspense>
    </>
  );
}
