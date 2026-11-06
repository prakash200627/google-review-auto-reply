import { redirect } from "next/navigation";
import { LocationVerificationPanel } from "@/components/LocationVerificationPanel";
import { Breadcrumbs } from "@/components/nav/Breadcrumbs";
import { ReviewsPanel } from "@/components/ReviewsPanel";
import {
  isAuthUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import {
  assertUserCanAccessLocation,
} from "@/lib/auth/googleRouteAuth";
import { resolveAuthorizedOrgId } from "@/lib/auth/resolveOrgContext";
import { isLocationVerificationStatus } from "@/lib/google/verification";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";
import { toLocationSummary } from "@/lib/google/syncLocations";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ locationId: string }>;
};

export default async function GmbLocationDetailPage({ params }: PageProps) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    redirect("/login");
  }

  const { locationId } = await params;
  const orgId = await resolveAuthorizedOrgId(auth.user);
  if (!orgId) {
    redirect("/gmb/locations");
  }

  const access = await assertUserCanAccessLocation({
    user: auth.user,
    orgId,
    locationId,
  });
  if (!access.ok) {
    redirect("/gmb/locations");
  }

  await connectToDatabase();
  const location = await Location.findOne({ _id: locationId, orgId }).lean();
  if (!location) {
    redirect("/gmb/locations");
  }

  const business = location.businessId
    ? await Business.findById(location.businessId).select("name").lean()
    : null;

  const summary = toLocationSummary(location);
  const isSuperAdmin = auth.user.role === "superadmin";
  const verificationStatus = isLocationVerificationStatus(
    location.verificationStatus
  )
    ? location.verificationStatus
    : "unknown";

  const title = summary.title || summary.googleLocationName;

  return (
    <>
      <div className="mb-4 space-y-1">
        <Breadcrumbs
          items={[
            { label: "GMB", href: "/gmb" },
            { label: "Locations", href: "/gmb/locations" },
            { label: title },
          ]}
        />
        <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
        <p className="text-sm text-zinc-600">{summary.address || "No address"}</p>
        <p className="font-mono text-xs text-zinc-500 break-all">
          {summary.googleLocationName}
        </p>
        <p className="text-xs text-zinc-600">
          Internal business:{" "}
          {business?.name ||
            (location.businessId
              ? String(location.businessId)
              : "Unassigned — Super Admin must assign under Businesses")}
        </p>
        <p className="text-xs text-zinc-600">
          Verification status:{" "}
          <span className="font-medium text-zinc-800">{verificationStatus}</span>
          {location.verificationLastCheckedAt
            ? ` · checked ${new Date(location.verificationLastCheckedAt).toLocaleString()}`
            : " · not checked yet"}
        </p>
      </div>
      {isSuperAdmin && (
        <LocationVerificationPanel
          locationId={String(location._id)}
          initial={{
            locationId: String(location._id),
            businessInfoName: location.businessInfoName,
            verificationStatus,
            verificationLastCheckedAt: location.verificationLastCheckedAt
              ? new Date(location.verificationLastCheckedAt).toISOString()
              : null,
            verificationHasVoiceOfMerchant:
              typeof location.verificationHasVoiceOfMerchant === "boolean"
                ? location.verificationHasVoiceOfMerchant
                : null,
            verificationHasBusinessAuthority:
              typeof location.verificationHasBusinessAuthority === "boolean"
                ? location.verificationHasBusinessAuthority
                : null,
            verificationRecommendedAction:
              location.verificationRecommendedAction || "",
            latestVerificationName: location.latestVerificationName || "",
            latestVerificationMethod: location.latestVerificationMethod || "",
            latestVerificationState: location.latestVerificationState || "",
            verificationLastError: location.verificationLastError || "",
            publicVisibilityClaim: false,
          }}
        />
      )}
      <ReviewsPanel
        initialLocations={[summary]}
        initialError={null}
        canDiscoverLocations={false}
      />
    </>
  );
}
