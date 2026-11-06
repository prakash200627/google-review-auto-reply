import Link from "next/link";
import { redirect } from "next/navigation";
import { GmbDiscoverLocationsButton } from "@/components/gmb/GmbDiscoverLocationsButton";
import {
  isAuthUser,
  listActiveBusinessIdsForUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import { resolveAuthorizedOrgId } from "@/lib/auth/resolveOrgContext";
import { listVisibleLocationsForUser } from "@/lib/auth/visibleLocations";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";

export const dynamic = "force-dynamic";

export default async function GmbLocationsPage() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    redirect("/login");
  }

  const orgId = await resolveAuthorizedOrgId(auth.user);
  let error: string | null = null;
  let rows: Array<{
    id: string;
    title: string;
    address: string;
    googleLocationName: string;
    businessId: string | null;
    businessName: string | null;
    lastDiscoveryAt: string | null;
    lastReviewsSyncAt: string | null;
  }> = [];

  if (!orgId) {
    error =
      auth.user.role === "superadmin"
        ? "No organization session. Connect Google under /gmb or select an organization."
        : "No active business workspace. You can still open ORM for stored data.";
  } else {
    try {
      const locations = await listVisibleLocationsForUser({
        user: auth.user,
        orgId,
      });
      await connectToDatabase();
      const locDocs = await Location.find({
        _id: { $in: locations.map((l) => l.id) },
      })
        .select("_id businessId")
        .lean();
      const businessIds = locDocs
        .map((l) => (l.businessId ? String(l.businessId) : null))
        .filter((id): id is string => Boolean(id));
      const businesses = businessIds.length
        ? await Business.find({ _id: { $in: businessIds } })
            .select("name")
            .lean()
        : [];
      const nameById = new Map(
        businesses.map((b) => [String(b._id), b.name || "Business"])
      );
      const bizByLoc = new Map(
        locDocs.map((l) => [
          String(l._id),
          l.businessId ? String(l.businessId) : null,
        ])
      );

      rows = locations.map((loc) => {
        const businessId = bizByLoc.get(loc.id) || null;
        return {
          id: loc.id,
          title: loc.title || loc.googleLocationName,
          address: loc.address || "",
          googleLocationName: loc.googleLocationName,
          businessId,
          businessName: businessId ? nameById.get(businessId) || null : null,
          lastDiscoveryAt: loc.lastDiscoveryAt,
          lastReviewsSyncAt: loc.lastReviewsSyncAt,
        };
      });

      if (auth.user.role !== "superadmin") {
        const allowed = await listActiveBusinessIdsForUser(auth.user);
        rows = rows.filter(
          (r) => r.businessId && allowed.includes(r.businessId)
        );
      }
    } catch {
      error = "Could not load locations.";
    }
  }

  return (
    <>
      <p className="mb-4 text-sm text-zinc-600">
        Locations come from the TRONX Google connection. Assignment to
        businesses is Super Admin only and never automatic. Open a location to
        fetch and store Google reviews (never automatic; never publishes
        replies). Day-to-day reply work lives under{" "}
        <Link className="underline" href="/orm/reviews">
          ORM → Reviews
        </Link>
        .
      </p>
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Link className="underline" href="/gmb">
          Connection
        </Link>
        {auth.user.role === "superadmin" && (
          <>
            <Link className="underline" href="/gmb/locations/create">
              Create Google location
            </Link>
            <Link className="underline" href="/admin/onboarding">
              Onboard business + group
            </Link>
            <Link className="underline" href="/admin/businesses">
              Assign to businesses
            </Link>
          </>
        )}
      </div>
      {auth.user.role === "superadmin" && orgId && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4">
          <p className="mb-2 text-sm font-medium text-zinc-900">
            Discovery / sync
          </p>
          <GmbDiscoverLocationsButton />
        </div>
      )}
      {error && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {error}
        </p>
      )}
      {!error && rows.length === 0 && (
        <p className="text-sm text-zinc-500">
          No locations visible for your account yet.
        </p>
      )}
      <ul className="space-y-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-lg border border-zinc-200 bg-white p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium text-zinc-900">{row.title}</p>
                <p className="text-xs text-zinc-500">{row.address || "No address"}</p>
                <p className="mt-1 font-mono text-xs text-zinc-600 break-all">
                  {row.googleLocationName}
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  Business:{" "}
                  {row.businessName ||
                    (row.businessId ? row.businessId : "Unassigned")}
                </p>
              </div>
              <Link
                href={`/gmb/locations/${encodeURIComponent(row.id)}`}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
              >
                Open
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
