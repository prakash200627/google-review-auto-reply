import mongoose from "mongoose";
import { Location } from "@/models/Location";

/** Product rule: one Business ↔ at most one Google Business Profile location. */
export const MAX_LOCATIONS_PER_BUSINESS = 1;

export type LocationAssignmentCandidate = {
  _id: mongoose.Types.ObjectId;
  orgId: mongoose.Types.ObjectId;
  businessId?: mongoose.Types.ObjectId | null;
  googleLocationName: string;
};

export class LocationAssignmentError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "LocationAssignmentError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Validate explicit location assignment for a business.
 * Never auto-assigns; rejects invalid IDs, org mismatches, duplicates,
 * and more than {@link MAX_LOCATIONS_PER_BUSINESS} location(s).
 *
 * MongoDB safeguards:
 * - Location already has unique `{ orgId, googleLocationName }`.
 * - Partial unique index `location_businessId_unique_partial` on
 *   `Location.businessId` (ObjectId only) — apply via
 *   `scripts/ensureLocationBusinessIdUniqueIndex.mjs` after duplicate diagnostics.
 *   Do not syncIndexes blindly in production if duplicates may exist.
 */
export function validateLocationAssignmentInput(input: {
  orgId: string;
  locationIds: unknown;
  currentBusinessId?: string | null;
}): string[] {
  if (!mongoose.isValidObjectId(input.orgId)) {
    throw new LocationAssignmentError("Invalid organization id.", {
      code: "invalid_org",
      status: 400,
    });
  }

  if (!Array.isArray(input.locationIds)) {
    throw new LocationAssignmentError("locationIds must be an array.", {
      code: "invalid_locations",
      status: 400,
    });
  }

  const ids = input.locationIds.map((id) => String(id));
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new LocationAssignmentError(
      "Duplicate location ids are not allowed in one assignment.",
      { code: "duplicate_location_ids", status: 400 }
    );
  }

  if (ids.length > MAX_LOCATIONS_PER_BUSINESS) {
    throw new LocationAssignmentError(
      `A business may be assigned at most ${MAX_LOCATIONS_PER_BUSINESS} Google location.`,
      { code: "too_many_locations", status: 400 }
    );
  }

  for (const id of ids) {
    if (!mongoose.isValidObjectId(id)) {
      throw new LocationAssignmentError(`Invalid location id: ${id}`, {
        code: "invalid_location_id",
        status: 400,
      });
    }
  }

  return ids;
}

/**
 * Ensure candidates are under the org and not owned by a different business.
 * Reassignment to another business requires an explicit prior unassignment
 * (clear `businessId` / remove from the previous business's `locationIds`)
 * before a new assignment is accepted — this function never steals a location.
 */
export function assertAssignableLocations(input: {
  orgId: string;
  requestedIds: string[];
  found: LocationAssignmentCandidate[];
  currentBusinessId?: string | null;
}): LocationAssignmentCandidate[] {
  const { orgId, requestedIds, found, currentBusinessId } = input;

  if (requestedIds.length > MAX_LOCATIONS_PER_BUSINESS) {
    throw new LocationAssignmentError(
      `A business may be assigned at most ${MAX_LOCATIONS_PER_BUSINESS} Google location.`,
      { code: "too_many_locations", status: 400 }
    );
  }

  if (found.length !== requestedIds.length) {
    throw new LocationAssignmentError(
      "One or more locations were not found under the selected organization.",
      { code: "location_org_mismatch", status: 400 }
    );
  }

  for (const loc of found) {
    if (String(loc.orgId) !== orgId) {
      throw new LocationAssignmentError(
        "Location organization mismatch.",
        { code: "location_org_mismatch", status: 400 }
      );
    }
    if (
      loc.businessId &&
      (!currentBusinessId || String(loc.businessId) !== currentBusinessId)
    ) {
      throw new LocationAssignmentError(
        "A selected location is already assigned to another business.",
        { code: "location_already_assigned", status: 409 }
      );
    }
  }

  return found;
}

export async function loadAssignableLocations(input: {
  orgId: string;
  locationIds: string[];
}): Promise<LocationAssignmentCandidate[]> {
  return Location.find({
    _id: { $in: input.locationIds },
    orgId: input.orgId,
  })
    .select("orgId businessId googleLocationName")
    .lean();
}
