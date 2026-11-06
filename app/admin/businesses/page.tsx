import Link from "next/link";
import { AdminBusinessesPanel } from "@/components/AdminBusinessesPanel";
import { requirePageSuperAdmin } from "@/lib/auth/requirePageAuth";
import {
  ADMIN_LOCATION_LIST_LIMITS,
  buildLocationIdentityKey,
  dedupeLocationsByIdentity,
} from "@/lib/location/identity";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";
import { User } from "@/models/User";
import { resolveBusinessLifecycle } from "@/lib/business/lifecycle";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import { readOrganizationId } from "@/lib/org/session";

export const dynamic = "force-dynamic";

export default async function AdminBusinessesPage() {
  await requirePageSuperAdmin();

  await connectToDatabase();
  const defaultOrgId = await readOrganizationId();
  const [businesses, unassignedRaw] = await Promise.all([
    Business.find({}).sort({ name: 1 }).lean(),
    defaultOrgId
      ? Location.find({
          orgId: defaultOrgId,
          $or: [{ businessId: null }, { businessId: { $exists: false } }],
        })
          .sort({ title: 1, updatedAt: -1 })
          .limit(ADMIN_LOCATION_LIST_LIMITS.maxScan)
          .lean()
      : Promise.resolve([]),
  ]);

  const ownerIds = businesses
    .map((b) => b.ownerUserId)
    .filter(Boolean)
    .map((id) => String(id));
  const owners = ownerIds.length
    ? await User.find({ _id: { $in: ownerIds } })
        .select("email active")
        .lean()
    : [];
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));

  const initialBusinesses = await Promise.all(
    businesses.map(async (b) => {
      const owner = b.ownerUserId
        ? ownerById.get(String(b.ownerUserId))
        : null;
      const reviewCount = await Review.countDocuments({ businessId: b._id });
      return {
        id: String(b._id),
        name: b.name,
        active: Boolean(b.active),
        status: resolveBusinessLifecycle(b),
        replyMode: b.replyMode || "manual",
        brandVoice: b.brandVoice || "friendly",
        preferredLanguage: b.preferredLanguage || "English",
        locationIds: (b.locationIds || []).map((id) => String(id)),
        reviewCount,
        ownerUserId: b.ownerUserId ? String(b.ownerUserId) : null,
        ownerEmail: owner?.email || null,
        ownerActive: owner ? Boolean(owner.active) : null,
        orgId: String(b.orgId),
        plan: toPlanSnapshot(b.plan as never),
      };
    })
  );

  const { unique: unassignedUnique } = dedupeLocationsByIdentity(unassignedRaw);
  const initialUnassigned = unassignedUnique
    .slice(0, ADMIN_LOCATION_LIST_LIMITS.defaultLimit)
    .map((loc) => {
      const orgId = String(loc.orgId);
      const googleLocationName = String(loc.googleLocationName || "");
      const identityKey = buildLocationIdentityKey(orgId, googleLocationName);
      if (!identityKey) return null;
      const address =
        typeof loc.address === "string" && loc.address.trim()
          ? loc.address.trim()
          : "";
      return {
        id: String(loc._id),
        title: loc.title || "",
        address,
        addressUnavailable: !address,
        orgId,
        googleLocationName,
        identityKey,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  return (
    <>
      <p className="mb-4 text-sm text-zinc-600">
        For the guided business + group + Google location workflow with
        review/confirm, use{" "}
        <Link className="underline" href="/admin/onboarding">
          Onboarding
        </Link>
        . This page remains available for edits, owners, and plans.
      </p>
      <AdminBusinessesPanel
        defaultOrgId={defaultOrgId}
        initialBusinesses={initialBusinesses}
        initialUnassigned={initialUnassigned}
      />
    </>
  );
}
