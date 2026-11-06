import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import {
  assertBusinessAccess,
  isAuthUser,
  listActiveBusinessIdsForUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import {
  assertBusinessOperationAllowed,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import { OwnerBusinessSwitcher } from "@/components/OwnerBusinessSwitcher";
import { resolveOwnerBusinessId } from "@/lib/business/ownerWorkspace";
import { EntitlementError } from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { GmbServiceJob } from "@/models/GmbServiceJob";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ businessId?: string }>;
};

export default async function ServicesPage({ searchParams }: PageProps) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) redirect("/login");
  if (auth.user.role === "superadmin") {
    redirect("/admin/businesses");
  }

  const params = (await searchParams) || {};
  const businessId = await resolveOwnerBusinessId(
    auth.user,
    typeof params.businessId === "string" ? params.businessId : null
  );
  const activeIds = await listActiveBusinessIdsForUser(auth.user);
  const businessChoices =
    activeIds.length > 1
      ? (
          await Business.find({ _id: { $in: activeIds } })
            .select("name")
            .lean()
        ).map((b) => ({ id: String(b._id), name: b.name || "Business" }))
      : [];

  let error: string | null = null;
  let jobs: Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    ownerSummary: string;
    updatedAt: string | null;
  }> = [];

  if (!businessId) {
    error = "No active business is assigned to your account.";
  } else {
    const access = await assertBusinessAccess(auth.user, businessId);
    if (!access.ok) {
      error = "You do not have access to this business.";
    } else {
      try {
        await assertBusinessOperationAllowed({
          businessId,
          business: access.business,
          action: "read_services",
        });
        await connectToDatabase();
        const rows = await GmbServiceJob.find({ businessId })
          .sort({ updatedAt: -1 })
          .lean();
        jobs = rows.map((j) => ({
          id: String(j._id),
          title: j.title,
          type: j.type,
          status: j.status,
          ownerSummary: j.ownerSummary || "",
          updatedAt: j.updatedAt
            ? new Date(j.updatedAt as Date).toISOString()
            : null,
        }));
      } catch (err) {
        if (
          err instanceof OperationalGuardError ||
          err instanceof EntitlementError
        ) {
          error = err.message;
        } else {
          error = "Could not load service jobs.";
        }
      }
    }
  }

  return (
    <AppShell title="GMB services" module="orm">
      <div className="space-y-4">
        <p className="text-sm text-zinc-700">
          Status of TRONX support work on your existing Google Business Profile.
          This does not create profiles or claim Google approval.{" "}
          <Link href="/orm" className="underline">
            Dashboard
          </Link>
        </p>
        <OwnerBusinessSwitcher
          businesses={businessChoices}
          currentBusinessId={businessId}
          basePath="/services"
        />
        {error && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            {error}
          </p>
        )}
        {!error && jobs.length === 0 && (
          <p className="text-sm text-zinc-600">No service jobs on file.</p>
        )}
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
          {jobs.map((j) => (
            <li key={j.id} className="px-4 py-3 text-sm">
              <p className="font-medium text-zinc-900">
                {j.title}{" "}
                <span className="font-normal text-zinc-500">
                  · {j.type} · {j.status}
                </span>
              </p>
              {j.ownerSummary ? (
                <p className="mt-1 text-zinc-700">{j.ownerSummary}</p>
              ) : null}
              {j.updatedAt ? (
                <p className="mt-1 text-xs text-zinc-500">
                  Updated {new Date(j.updatedAt).toLocaleString()}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}
