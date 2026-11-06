import Link from "next/link";
import { redirect } from "next/navigation";
import { OrmLandingClient } from "@/components/orm/OrmLandingClient";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";
import { resolveAuthorizedOrgId } from "@/lib/auth/resolveOrgContext";
import { getOrmLandingChoices } from "@/lib/dashboard/ormDashboard";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ businessId?: string }>;
};

export default async function OrmDashboardPage({ searchParams }: PageProps) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    redirect("/login");
  }

  const params = (await searchParams) || {};
  const requestedBusinessId =
    typeof params.businessId === "string" && params.businessId.trim()
      ? params.businessId.trim()
      : null;

  // Preserve legacy /orm?businessId=… entry points.
  if (requestedBusinessId) {
    redirect(`/orm/business/${encodeURIComponent(requestedBusinessId)}`);
  }

  const isSuperAdmin = auth.user.role === "superadmin";
  const orgId = await resolveAuthorizedOrgId(auth.user);
  const choices = await getOrmLandingChoices(auth.user, { orgId });

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
          ORM overview
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          {isSuperAdmin
            ? "Open a business or group dashboard for the active organization. Platform administration stays under Admin."
            : "Open dashboards for businesses and groups assigned to your account."}
        </p>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <Link className="underline" href="/orm/reviews">
            Reviews inbox
          </Link>
          <Link className="underline" href="/gmb">
            GMB workspace
          </Link>
          {isSuperAdmin && (
            <Link className="underline" href="/admin/dashboard">
              Admin dashboard
            </Link>
          )}
        </div>
      </section>

      <OrmLandingClient
        businesses={choices.businesses}
        groups={choices.groups}
        isSuperAdmin={isSuperAdmin}
        singleBusinessId={choices.singleBusinessId}
        needsOrgSelection={choices.needsOrgSelection}
        orgId={choices.orgId}
      />
    </div>
  );
}
