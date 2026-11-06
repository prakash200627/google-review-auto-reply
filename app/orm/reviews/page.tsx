import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ReviewsWorkspace } from "@/components/reviews/ReviewsWorkspace";
import {
  isAuthUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import { assertGroupAccess } from "@/lib/auth/assertGroupAccess";
import { resolveReviewsBusinessScope } from "@/lib/auth/reviewsScope";
import { resolveOwnerBusinessId } from "@/lib/business/ownerWorkspace";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{
    businessId?: string;
    groupId?: string;
    tab?: string;
  }>;
};

export default async function ReviewsPage({ searchParams }: PageProps) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    redirect("/login");
  }

  const isSuperAdmin = auth.user.role === "superadmin";
  const params = (await searchParams) || {};
  let selectedBusinessId: string | null = null;
  let businessName: string | null = null;
  let selectedGroupId: string | null = null;
  let groupName: string | null = null;
  let businessChoices: Array<{ id: string; name: string }> = [];

  const scope = await resolveReviewsBusinessScope(auth.user);
  if (!scope.ok) {
    return (
      <div className="space-y-3">
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {scope.message}
        </p>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/orm" className="underline">
            Back to ORM overview
          </Link>
          <Link href="/admin/businesses" className="underline">
            Select organization
          </Link>
        </div>
      </div>
    );
  }

  await connectToDatabase();

  if (typeof params.groupId === "string" && params.groupId.trim()) {
    const groupAccess = await assertGroupAccess(auth.user, params.groupId);
    if (groupAccess.ok) {
      selectedGroupId = String(groupAccess.group._id);
      groupName = groupAccess.group.name;
    } else if (groupAccess.response.status === 403) {
      const body = (await groupAccess.response
        .clone()
        .json()
        .catch(() => null)) as { code?: string; message?: string } | null;
      if (body?.code === "org_mismatch" || body?.code === "org_required") {
        return (
          <div className="space-y-3">
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {body.message ||
                "This group belongs to a different organization than your active session."}
            </p>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link href="/orm/reviews" className="underline">
                Clear group filter
              </Link>
              <Link href="/admin/businesses" className="underline">
                Select organization
              </Link>
            </div>
          </div>
        );
      }
      redirect("/access-denied");
    }
    // Invalid / missing group: ignore filter rather than hard-fail the inbox.
  }

  if (!isSuperAdmin) {
    selectedBusinessId = await resolveOwnerBusinessId(
      auth.user,
      typeof params.businessId === "string" ? params.businessId : null
    );
    if (scope.businessIds.length > 0) {
      const businesses = await Business.find({
        _id: { $in: scope.businessIds },
      })
        .select("name")
        .sort({ name: 1 })
        .lean();
      businessChoices = businesses.map((b) => ({
        id: String(b._id),
        name: b.name || "Business",
      }));
      if (selectedBusinessId) {
        businessName =
          businessChoices.find((b) => b.id === selectedBusinessId)?.name ||
          null;
      }
    }
  } else {
    if (scope.businessIds.length > 0) {
      const businesses = await Business.find({
        _id: { $in: scope.businessIds },
      })
        .select("name")
        .sort({ name: 1 })
        .lean();
      businessChoices = businesses.map((b) => ({
        id: String(b._id),
        name: b.name || "Business",
      }));
    }

    if (typeof params.businessId === "string" && params.businessId) {
      const inScope = businessChoices.some((b) => b.id === params.businessId);
      if (!inScope) {
        const biz = await Business.findById(params.businessId)
          .select("name orgId")
          .lean();
        return (
          <div className="space-y-3">
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {biz
                ? "This business belongs to a different organization than your active session."
                : "Business not found in the active organization."}
            </p>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link href="/orm/reviews" className="underline">
                Open Reviews for this organization
              </Link>
              <Link href="/admin/businesses" className="underline">
                Select organization
              </Link>
            </div>
          </div>
        );
      }
      selectedBusinessId = params.businessId;
      businessName =
        businessChoices.find((b) => b.id === selectedBusinessId)?.name || null;
    }
  }

  if (!groupName && selectedGroupId) {
    const g = await BusinessGroup.findById(selectedGroupId)
      .select("name")
      .lean();
    groupName = g?.name || null;
  }

  return (
    <Suspense
      fallback={
        <p className="text-sm text-zinc-500" role="status">
          Loading reviews workspace…
        </p>
      }
    >
      <ReviewsWorkspace
        initialBusinessId={selectedBusinessId}
        initialGroupId={selectedGroupId}
        businessName={businessName}
        groupName={groupName}
        businessChoices={businessChoices}
        isSuperAdmin={isSuperAdmin}
        activeOrgId={scope.orgId}
      />
    </Suspense>
  );
}
