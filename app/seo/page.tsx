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
import { SeoKeyword } from "@/models/SeoKeyword";
import { SeoRanking } from "@/models/SeoRanking";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ businessId?: string }>;
};

export default async function SeoPage({ searchParams }: PageProps) {
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
  let keywords: Array<{
    id: string;
    keyword: string;
    targetLocation: string;
  }> = [];
  let rankings: Array<{
    keywordId: string;
    position: number;
    observedAt: string | null;
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
          action: "read_seo",
        });
        await connectToDatabase();
        const kw = await SeoKeyword.find({ businessId, active: true })
          .sort({ keyword: 1 })
          .lean();
        keywords = kw.map((k) => ({
          id: String(k._id),
          keyword: k.keyword,
          targetLocation: k.targetLocation || "",
        }));
        const ids = kw.map((k) => k._id);
        const rank = ids.length
          ? await SeoRanking.find({ keywordId: { $in: ids } })
              .sort({ observedAt: -1 })
              .limit(100)
              .lean()
          : [];
        rankings = rank.map((r) => ({
          keywordId: String(r.keywordId),
          position: r.position,
          observedAt: r.observedAt
            ? new Date(r.observedAt).toISOString()
            : null,
        }));
      } catch (err) {
        if (
          err instanceof OperationalGuardError ||
          err instanceof EntitlementError
        ) {
          error = err.message;
        } else {
          error = "Could not load SEO data.";
        }
      }
    }
  }

  return (
    <AppShell title="Local SEO" module="orm">
      <div className="space-y-4">
        <p className="text-sm text-zinc-700">
          Staff-managed Geographic/Local SEO (GEO). Read-only for owners. No
          automatic ranking collection.{" "}
          <Link href="/orm" className="underline">
            Dashboard
          </Link>
        </p>
        <OwnerBusinessSwitcher
          businesses={businessChoices}
          currentBusinessId={businessId}
          basePath="/seo"
        />
        {error && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            {error}
          </p>
        )}
        {!error && keywords.length === 0 && (
          <p className="text-sm text-zinc-600">
            No keywords recorded yet. Ask TRONX staff to add target keywords.
          </p>
        )}
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
          {keywords.map((k) => {
            const latest = rankings.find((r) => r.keywordId === k.id);
            return (
              <li key={k.id} className="px-4 py-3 text-sm">
                <p className="font-medium text-zinc-900">{k.keyword}</p>
                <p className="text-zinc-600">
                  Target: {k.targetLocation || "—"} · Latest position:{" "}
                  {latest ? latest.position : "Unavailable"}
                  {latest?.observedAt
                    ? ` · observed ${new Date(latest.observedAt).toLocaleDateString()}`
                    : ""}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </AppShell>
  );
}
