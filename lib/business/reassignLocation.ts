/**
 * Explicit Google location reassignment between TRONX businesses.
 * Never steals a location without confirmReassign=true.
 * Ownership mutations run inside MongoDB transactions — never detach then
 * leave the location unassigned on failure.
 * Does not change verification status or Google profile data.
 */

import mongoose, { type ClientSession } from "mongoose";
import { LocationAssignmentError } from "@/lib/business/assignLocations";
import {
  clearReviewBusinessIdsForLocations,
  syncReviewBusinessIdsForLocations,
} from "@/lib/business/stats";
import {
  isMongoDuplicateKeyError,
  withMongoTransaction,
} from "@/lib/mongo/transactions";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";

export type LocationAssignmentConflict = {
  locationId: string;
  googleLocationName: string;
  title: string;
  currentBusinessId: string;
  currentBusinessName: string;
  currentGroupId: string | null;
};

/**
 * Inspect whether a location is free or already bound to another business.
 */
export async function getLocationAssignmentConflict(
  locationId: string,
  session?: ClientSession | null
): Promise<LocationAssignmentConflict | null> {
  if (!mongoose.isValidObjectId(locationId)) {
    throw new LocationAssignmentError("Invalid location id.", {
      code: "invalid_location_id",
      status: 400,
    });
  }
  await connectToDatabase();
  const locationQuery = Location.findById(locationId).select(
    "businessId googleLocationName title"
  );
  if (session) locationQuery.session(session);
  const location = await locationQuery.lean();
  if (!location) {
    throw new LocationAssignmentError("Location not found.", {
      code: "location_not_found",
      status: 404,
    });
  }
  if (!location.businessId) return null;

  const businessQuery = Business.findById(location.businessId).select(
    "name groupId"
  );
  if (session) businessQuery.session(session);
  const business = await businessQuery.lean();
  return {
    locationId: String(location._id),
    googleLocationName: location.googleLocationName || "",
    title: location.title || "",
    currentBusinessId: String(location.businessId),
    currentBusinessName: business?.name || "another business",
    currentGroupId: business?.groupId ? String(business.groupId) : null,
  };
}

/**
 * Read-only check used before transactional assign.
 * Does NOT detach the location.
 */
export async function assertLocationMovable(input: {
  locationId: string;
  targetBusinessId?: string | null;
  confirmReassign?: boolean;
  session?: ClientSession | null;
}): Promise<{
  conflict: LocationAssignmentConflict | null;
  requiresReassign: boolean;
}> {
  const conflict = await getLocationAssignmentConflict(
    input.locationId,
    input.session
  );
  if (!conflict) {
    return { conflict: null, requiresReassign: false };
  }
  if (
    input.targetBusinessId &&
    conflict.currentBusinessId === String(input.targetBusinessId)
  ) {
    return { conflict: null, requiresReassign: false };
  }
  if (!input.confirmReassign) {
    throw new LocationAssignmentError(
      `This location is already assigned to "${conflict.currentBusinessName}". Confirm an explicit reassignment to move it.`,
      { code: "location_already_assigned", status: 409 }
    );
  }
  return { conflict, requiresReassign: true };
}

/**
 * Explicit unassign (SA intentional clear). Uses a transaction so Business
 * locationIds and Location.businessId stay consistent.
 */
export async function unassignLocationFromBusiness(input: {
  locationId: string;
  expectedBusinessId?: string | null;
}): Promise<{ previousBusinessId: string | null }> {
  const { locationId, expectedBusinessId } = input;
  if (!mongoose.isValidObjectId(locationId)) {
    throw new LocationAssignmentError("Invalid location id.", {
      code: "invalid_location_id",
      status: 400,
    });
  }

  return withMongoTransaction(async (session) => {
    const location = await Location.findById(locationId)
      .select("businessId googleLocationName")
      .session(session)
      .exec();
    if (!location) {
      throw new LocationAssignmentError("Location not found.", {
        code: "location_not_found",
        status: 404,
      });
    }

    const previousBusinessId = location.businessId
      ? String(location.businessId)
      : null;
    if (!previousBusinessId) {
      return { previousBusinessId: null };
    }

    if (
      expectedBusinessId &&
      previousBusinessId !== String(expectedBusinessId)
    ) {
      throw new LocationAssignmentError(
        "Location is not assigned to the expected business.",
        { code: "assignment_mismatch", status: 409 }
      );
    }

    const previous = await Business.findById(previousBusinessId)
      .select("locationIds googleLocationNames")
      .session(session)
      .exec();
    if (previous) {
      previous.locationIds = (previous.locationIds || []).filter(
        (id) => String(id) !== locationId
      );
      previous.googleLocationNames = (
        previous.googleLocationNames || []
      ).filter((name) => name !== location.googleLocationName);
      await previous.save({ session });
      await clearReviewBusinessIdsForLocations({
        businessId: previousBusinessId,
        locationIds: [locationId],
        session,
      });
    }

    location.businessId = null;
    await location.save({ session });
    return { previousBusinessId };
  });
}

/**
 * Atomically move/assign a location onto targetBusinessId.
 * Previous owner is only cleared inside the same transaction as the new bind.
 */
export async function assignLocationToBusinessAtomic(input: {
  locationId: string;
  targetBusinessId: string;
  confirmReassign?: boolean;
  /** When true, clear target's prior location (max-one rule) inside the txn. */
  replaceTargetExistingLocation?: boolean;
}): Promise<{
  reassignedFrom: LocationAssignmentConflict | null;
  googleLocationName: string;
}> {
  const { locationId, targetBusinessId, confirmReassign } = input;
  if (
    !mongoose.isValidObjectId(locationId) ||
    !mongoose.isValidObjectId(targetBusinessId)
  ) {
    throw new LocationAssignmentError("Invalid location or business id.", {
      code: "invalid_id",
      status: 400,
    });
  }

  try {
    return await withMongoTransaction(async (session) => {
      const movable = await assertLocationMovable({
        locationId,
        targetBusinessId,
        confirmReassign,
        session,
      });

      const location = await Location.findById(locationId)
        .select("businessId googleLocationName orgId")
        .session(session)
        .exec();
      if (!location) {
        throw new LocationAssignmentError("Location not found.", {
          code: "location_not_found",
          status: 404,
        });
      }

      const target = await Business.findById(targetBusinessId)
        .select("orgId locationIds googleLocationNames")
        .session(session)
        .exec();
      if (!target) {
        throw new LocationAssignmentError("Target business not found.", {
          code: "business_not_found",
          status: 404,
        });
      }
      if (String(target.orgId) !== String(location.orgId)) {
        throw new LocationAssignmentError(
          "Location and business must share the same organization.",
          { code: "location_org_mismatch", status: 400 }
        );
      }

      // Detach prior owner only inside this transaction.
      if (movable.requiresReassign && movable.conflict) {
        const previous = await Business.findById(
          movable.conflict.currentBusinessId
        )
          .select("locationIds googleLocationNames")
          .session(session)
          .exec();
        if (previous) {
          previous.locationIds = (previous.locationIds || []).filter(
            (id) => String(id) !== locationId
          );
          previous.googleLocationNames = (
            previous.googleLocationNames || []
          ).filter((name) => name !== location.googleLocationName);
          await previous.save({ session });
          await clearReviewBusinessIdsForLocations({
            businessId: movable.conflict.currentBusinessId,
            locationIds: [locationId],
            session,
          });
        }
      }

      // Clear target's previous location if replacing (max one).
      const priorTargetLocIds = (target.locationIds || []).map(String);
      if (
        input.replaceTargetExistingLocation !== false &&
        priorTargetLocIds.length > 0
      ) {
        const toClear = priorTargetLocIds.filter((id) => id !== locationId);
        if (toClear.length > 0) {
          await Location.updateMany(
            { _id: { $in: toClear }, businessId: target._id },
            { $set: { businessId: null } },
            { session }
          );
          await clearReviewBusinessIdsForLocations({
            businessId: targetBusinessId,
            locationIds: toClear,
            session,
          });
        }
      }

      location.businessId = target._id;
      try {
        await location.save({ session });
      } catch (err) {
        if (isMongoDuplicateKeyError(err)) {
          throw new LocationAssignmentError(
            "Another location is already assigned to this business (database unique constraint).",
            { code: "location_business_conflict", status: 409 }
          );
        }
        throw err;
      }

      target.locationIds = [location._id];
      target.googleLocationNames = [location.googleLocationName];
      await target.save({ session });

      await syncReviewBusinessIdsForLocations({
        businessId: targetBusinessId,
        locationIds: [locationId],
        session,
      });

      return {
        reassignedFrom: movable.requiresReassign ? movable.conflict : null,
        googleLocationName: location.googleLocationName,
      };
    });
  } catch (err) {
    if (err instanceof LocationAssignmentError) throw err;
    if (isMongoDuplicateKeyError(err)) {
      throw new LocationAssignmentError(
        "Location ownership conflict (database unique constraint on businessId).",
        { code: "location_business_conflict", status: 409 }
      );
    }
    throw err;
  }
}

/**
 * @deprecated Prefer assertLocationMovable + assignLocationToBusinessAtomic.
 * Kept as a thin wrapper that only validates — does not detach.
 */
export async function prepareLocationForAssignment(input: {
  locationId: string;
  targetBusinessId?: string | null;
  confirmReassign?: boolean;
}): Promise<{
  freed: boolean;
  previousBusinessId: string | null;
  conflict: LocationAssignmentConflict | null;
}> {
  const movable = await assertLocationMovable(input);
  return {
    freed: false,
    previousBusinessId: movable.conflict?.currentBusinessId || null,
    conflict: movable.conflict,
  };
}

/**
 * Atomically replace a business's location set (max one) inside a transaction.
 * Never clears ownership outside the same commit as the new assignment.
 * Pass `session` to join a caller-owned transaction (avoids nested txns).
 */
export async function replaceBusinessLocationsAtomic(input: {
  businessId: string;
  locationIds: string[];
  confirmReassign?: boolean;
  session?: ClientSession | null;
}): Promise<{
  googleLocationNames: string[];
  locationObjectIds: mongoose.Types.ObjectId[];
}> {
  const { businessId, locationIds, confirmReassign } = input;
  if (!mongoose.isValidObjectId(businessId)) {
    throw new LocationAssignmentError("Invalid business id.", {
      code: "invalid_id",
      status: 400,
    });
  }
  for (const id of locationIds) {
    if (!mongoose.isValidObjectId(id)) {
      throw new LocationAssignmentError(`Invalid location id: ${id}`, {
        code: "invalid_location_id",
        status: 400,
      });
    }
  }

  const run = async (session: ClientSession) => {
    const business = await Business.findById(businessId)
      .session(session)
      .exec();
    if (!business) {
      throw new LocationAssignmentError("Business not found.", {
        code: "business_not_found",
        status: 404,
      });
    }

    const previousLocationIds = (business.locationIds || []).map(String);
    const nextSet = new Set(locationIds);
    const removedLocationIds = previousLocationIds.filter(
      (id) => !nextSet.has(id)
    );

    for (const locId of locationIds) {
      await assertLocationMovable({
        locationId: locId,
        targetBusinessId: businessId,
        confirmReassign,
        session,
      });
    }

    // Detach locations being removed from this business only.
    if (removedLocationIds.length > 0) {
      await Location.updateMany(
        { _id: { $in: removedLocationIds }, businessId: business._id },
        { $set: { businessId: null } },
        { session }
      );
      await clearReviewBusinessIdsForLocations({
        businessId,
        locationIds: removedLocationIds,
        session,
      });
    }

    const assignedNames: string[] = [];
    const assignedIds: mongoose.Types.ObjectId[] = [];

    for (const locId of locationIds) {
      const location = await Location.findById(locId)
        .session(session)
        .exec();
      if (!location) {
        throw new LocationAssignmentError("Location not found.", {
          code: "location_not_found",
          status: 404,
        });
      }
      if (String(location.orgId) !== String(business.orgId)) {
        throw new LocationAssignmentError(
          "Location and business must share the same organization.",
          { code: "location_org_mismatch", status: 400 }
        );
      }

      const priorOwnerId = location.businessId
        ? String(location.businessId)
        : null;
      if (priorOwnerId && priorOwnerId !== businessId) {
        const previous = await Business.findById(priorOwnerId)
          .session(session)
          .exec();
        if (previous) {
          previous.locationIds = (previous.locationIds || []).filter(
            (id) => String(id) !== locId
          );
          previous.googleLocationNames = (
            previous.googleLocationNames || []
          ).filter((name) => name !== location.googleLocationName);
          await previous.save({ session });
          await clearReviewBusinessIdsForLocations({
            businessId: priorOwnerId,
            locationIds: [locId],
            session,
          });
        }
      }

      location.businessId = business._id;
      try {
        await location.save({ session });
      } catch (err) {
        if (isMongoDuplicateKeyError(err)) {
          throw new LocationAssignmentError(
            "Another location is already assigned to this business (database unique constraint).",
            { code: "location_business_conflict", status: 409 }
          );
        }
        throw err;
      }
      assignedIds.push(location._id);
      assignedNames.push(location.googleLocationName);
    }

    business.locationIds = assignedIds;
    business.googleLocationNames = assignedNames;
    await business.save({ session });

    if (locationIds.length > 0) {
      await syncReviewBusinessIdsForLocations({
        businessId,
        locationIds,
        session,
      });
    }

    return {
      googleLocationNames: assignedNames,
      locationObjectIds: assignedIds,
    };
  };

  try {
    if (input.session) {
      return await run(input.session);
    }
    return await withMongoTransaction(run);
  } catch (err) {
    if (err instanceof LocationAssignmentError) throw err;
    if (isMongoDuplicateKeyError(err)) {
      throw new LocationAssignmentError(
        "Location ownership conflict (database unique constraint on businessId).",
        { code: "location_business_conflict", status: 409 }
      );
    }
    throw err;
  }
}
