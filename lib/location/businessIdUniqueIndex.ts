/**
 * Partial unique index: at most one Location document per non-null businessId.
 * Enforces one Google location row per internal business at the database layer.
 *
 * Do not auto-create this index on every request. Use the diagnostic migration
 * script, then confirm status via getLocationBusinessIdUniqueIndexStatus().
 */

import { connectToDatabase } from "@/lib/mongodb";

export const LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME =
  "location_businessId_unique_partial";

export type LocationBusinessIdDuplicate = {
  businessId: string;
  locationIds: string[];
  count: number;
};

export type LocationBusinessIdIndexStatus = {
  indexName: string;
  present: boolean;
  unique: boolean;
  partial: boolean;
  /** True only when the expected unique partial index is present. */
  constraintActive: boolean;
  duplicates: LocationBusinessIdDuplicate[];
  message: string;
};

/**
 * Find businessIds that already appear on more than one Location document.
 * Read-only — never deletes or reassigns.
 */
export async function findDuplicateLocationBusinessIds(): Promise<
  LocationBusinessIdDuplicate[]
> {
  await connectToDatabase();
  const { Location } = await import("@/models/Location");
  const rows = await Location.aggregate<{
    _id: unknown;
    locationIds: unknown[];
    count: number;
  }>([
    {
      $match: {
        businessId: { $exists: true, $ne: null, $type: "objectId" },
      },
    },
    {
      $group: {
        _id: "$businessId",
        locationIds: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  return rows.map((row) => ({
    businessId: String(row._id),
    locationIds: (row.locationIds || []).map((id) => String(id)),
    count: row.count,
  }));
}

export async function getLocationBusinessIdUniqueIndexStatus(): Promise<LocationBusinessIdIndexStatus> {
  await connectToDatabase();
  const { Location } = await import("@/models/Location");
  const indexes = await Location.collection.indexes();
  const match = indexes.find(
    (idx) =>
      idx.name === LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME ||
      (idx.unique === true &&
        idx.key &&
        typeof idx.key === "object" &&
        Object.keys(idx.key as object).length === 1 &&
        (idx.key as { businessId?: number }).businessId === 1 &&
        Boolean(idx.partialFilterExpression))
  );

  const duplicates = await findDuplicateLocationBusinessIds();
  const present = Boolean(match);
  const unique = Boolean(match?.unique);
  const partial = Boolean(match?.partialFilterExpression);
  const constraintActive = present && unique && partial && duplicates.length === 0;

  let message: string;
  if (duplicates.length > 0) {
    message = `Found ${duplicates.length} businessId value(s) shared by multiple Location documents. Resolve duplicates before creating the unique index. No automatic reassignment was performed.`;
  } else if (!present) {
    message =
      "Partial unique index is not present. Run the diagnostic migration with --apply after confirming zero duplicates.";
  } else if (!unique || !partial) {
    message =
      "A businessId index exists but is not the expected unique partial index. Constraint is NOT considered active.";
  } else {
    message = "Partial unique index is present and no duplicate businessIds were found.";
  }

  return {
    indexName: LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME,
    present,
    unique,
    partial,
    constraintActive,
    duplicates,
    message,
  };
}

/**
 * Attempt to create the partial unique index.
 * Throws if duplicates exist or createIndex fails — never claims success falsely.
 */
export async function ensureLocationBusinessIdUniqueIndex(): Promise<LocationBusinessIdIndexStatus> {
  const before = await getLocationBusinessIdUniqueIndexStatus();
  if (before.duplicates.length > 0) {
    throw new Error(
      `REFUSED_INDEX_CREATE: ${before.duplicates.length} duplicate businessId group(s). Resolve manually before indexing.`
    );
  }

  await connectToDatabase();
  const { Location } = await import("@/models/Location");
  try {
    await Location.collection.createIndex(
      { businessId: 1 },
      {
        unique: true,
        name: LOCATION_BUSINESS_ID_UNIQUE_INDEX_NAME,
        partialFilterExpression: {
          businessId: { $exists: true, $type: "objectId" },
        },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "createIndex failed";
    throw new Error(`INDEX_CREATE_FAILED: ${message}`);
  }

  const after = await getLocationBusinessIdUniqueIndexStatus();
  if (!after.constraintActive) {
    throw new Error(
      `INDEX_CREATE_INCOMPLETE: ${after.message}. Do not treat the constraint as active.`
    );
  }
  return after;
}
