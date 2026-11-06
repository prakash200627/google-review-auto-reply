import mongoose from "mongoose";
import { LocationAssignmentError } from "@/lib/business/assignLocations";
import { normalizeGoogleLocationName } from "@/lib/location/identity";
import { connectToDatabase } from "@/lib/mongodb";
import { GoogleConnection } from "@/models/GoogleConnection";
import { Location } from "@/models/Location";
import { Organization } from "@/models/Organization";
import { Business } from "@/models/Business";

export type ResolvedCreateLocation = {
  locationId: string;
  orgId: string;
  googleLocationName: string;
  title: string;
  address: string;
  connection: {
    status: string;
    email: string;
    connectionSource: string;
  } | null;
};

/**
 * Resolve a Google location for Super Admin business creation.
 * orgId and ownership come only from the Location document — never from the client.
 * Does not detach ownership; use confirmReassign + a transaction to move.
 */
export async function resolveLocationForBusinessCreate(
  locationId: unknown,
  options: { allowAssigned?: boolean } = {}
): Promise<ResolvedCreateLocation> {
  const id = typeof locationId === "string" ? locationId.trim() : "";
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new LocationAssignmentError("Select a valid Google location.", {
      code: "invalid_location_id",
      status: 400,
    });
  }

  await connectToDatabase();
  const location = await Location.findById(id)
    .select(
      "orgId businessId googleLocationName title address googleAccountName"
    )
    .lean();

  if (!location) {
    throw new LocationAssignmentError(
      "Location not found. Discover locations under Reviews after connecting Google.",
      { code: "location_not_found", status: 404 }
    );
  }

  if (location.businessId && !options.allowAssigned) {
    const assigned = await Business.findById(location.businessId)
      .select("name")
      .lean();
    throw new LocationAssignmentError(
      `This location is already assigned to "${assigned?.name || "another business"}". Confirm an explicit reassignment to move it.`,
      { code: "location_already_assigned", status: 409 }
    );
  }

  const googleLocationName = normalizeGoogleLocationName(
    location.googleLocationName
  );
  if (!googleLocationName) {
    throw new LocationAssignmentError(
      "This location cache row is missing a valid Google location resource name and cannot be enrolled. Rediscover locations after connecting Google.",
      { code: "invalid_google_location_name", status: 400 }
    );
  }

  const orgId = String(location.orgId);
  const org = await Organization.findById(orgId).select("_id").lean();
  if (!org) {
    throw new LocationAssignmentError(
      "The location's organization no longer exists. Reconnect Google and rediscover locations.",
      { code: "org_missing", status: 400 }
    );
  }

  const connection = await GoogleConnection.findOne({
    orgId,
    status: { $in: ["active", "error"] },
    $or: [
      { connectionSource: "platform" },
      { connectionSource: { $exists: false } },
      { businessId: null },
    ],
    businessId: null,
  })
    .select("status googleAccountEmail connectionSource")
    .lean();

  if (!connection || connection.status !== "active") {
    throw new LocationAssignmentError(
      connection?.status === "error"
        ? "Google connection for this location's organization is in error. Reconnect Google under Settings, then retry."
        : "No active Google connection for this location's organization. Connect Google under GMB → Connection, discover under GMB → Locations, then retry.",
      { code: "connection_unavailable", status: 400 }
    );
  }

  return {
    locationId: String(location._id),
    orgId,
    googleLocationName,
    title: location.title || "",
    address: location.address || "",
    connection: {
      status: connection.status,
      email: connection.googleAccountEmail || "",
      connectionSource: connection.connectionSource || "platform",
    },
  };
}
