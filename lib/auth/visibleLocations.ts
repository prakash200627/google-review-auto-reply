import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Location } from "@/models/Location";
import {
  listActiveBusinessIdsForUser,
  type AuthUser,
} from "@/lib/auth/authorize";
import {
  listStoredLocationsForOrg,
  type SyncedLocationSummary,
} from "@/lib/google/syncLocations";

/**
 * Locations visible to the signed-in user for the given org.
 * Owners see only locations assigned to their active businesses.
 * Super Admin sees all org locations.
 * Never returns data for org-cookie-only callers — requires AuthUser.
 */
export async function listVisibleLocationsForUser(input: {
  user: AuthUser;
  orgId: string;
  /** When set for owners, only locations for this authorized business. */
  businessId?: string | null;
}): Promise<SyncedLocationSummary[]> {
  const { user, orgId } = input;
  if (!mongoose.isValidObjectId(orgId)) return [];

  const locations = await listStoredLocationsForOrg(orgId);

  // Super Admin: org-wide discovery list by default; when a businessId is
  // selected (Reviews / support scope), only that business's assigned rows.
  if (user.role === "superadmin") {
    if (!input.businessId) return locations;
    if (!mongoose.isValidObjectId(input.businessId)) return [];
    await connectToDatabase();
    const docs = await Location.find({
      orgId,
      businessId: input.businessId,
    })
      .select("_id")
      .lean();
    const allowed = new Set(docs.map((d) => String(d._id)));
    return locations.filter((loc) => allowed.has(loc.id));
  }

  const activeBusinessIds = await listActiveBusinessIdsForUser(user);
  if (activeBusinessIds.length === 0) return [];

  let scopeIds = activeBusinessIds;
  if (input.businessId) {
    if (!activeBusinessIds.includes(input.businessId)) return [];
    scopeIds = [input.businessId];
  }

  await connectToDatabase();
  const docs = await Location.find({
    orgId,
    businessId: { $in: scopeIds },
  })
    .select("_id")
    .lean();
  const allowed = new Set(docs.map((d) => String(d._id)));
  return locations.filter((loc) => allowed.has(loc.id));
}
