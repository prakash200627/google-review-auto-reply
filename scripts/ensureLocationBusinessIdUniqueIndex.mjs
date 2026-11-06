/**
 * Diagnostic + gated creation of Location.businessId partial unique index.
 *
 * Default: dry-run. Reports duplicate businessId groups. Never deletes or
 * reassigns ownership.
 *
 * Usage:
 *   node --env-file=.env.local scripts/ensureLocationBusinessIdUniqueIndex.mjs
 *   ALLOW_MIGRATE_APPLY=1 node --env-file=.env.local scripts/ensureLocationBusinessIdUniqueIndex.mjs --apply
 *
 * --apply creates the index only when zero duplicates exist.
 * Exit code 2 = duplicates / index refused; 1 = hard error; 0 = ok.
 */
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
const allowApply = process.env.ALLOW_MIGRATE_APPLY === "1";
const INDEX_NAME = "location_businessId_unique_partial";

async function findDuplicates(locations) {
  return locations
    .aggregate([
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
    ])
    .toArray();
}

async function main() {
  if (!uri) {
    console.log("MIGRATE_SKIP missing MONGODB_URI");
    process.exit(0);
  }

  if (APPLY && !allowApply) {
    console.error(
      "MIGRATE_REFUSED --apply requires ALLOW_MIGRATE_APPLY=1 and a non-production MONGODB_URI."
    );
    process.exit(1);
  }

  await mongoose.connect(uri, { bufferCommands: false });
  const locations = mongoose.connection.collection("locations");

  const duplicates = await findDuplicates(locations);
  const indexes = await locations.indexes();
  const existing = indexes.find((idx) => idx.name === INDEX_NAME);

  const report = {
    mode: APPLY ? "apply" : "dry-run",
    indexName: INDEX_NAME,
    duplicateGroups: duplicates.map((d) => ({
      businessId: String(d._id),
      count: d.count,
      locationIds: (d.locationIds || []).map(String),
    })),
    indexPresent: Boolean(existing),
    indexUnique: Boolean(existing?.unique),
    constraintActive: Boolean(
      existing?.unique && duplicates.length === 0
    ),
    note: "Never deletes or reassigns Location/Business ownership. Resolve duplicates manually before --apply.",
  };

  console.log(JSON.stringify(report, null, 2));

  if (duplicates.length > 0) {
    console.error(
      "REFUSED_INDEX_CREATE: duplicate businessId groups must be resolved first."
    );
    await mongoose.disconnect();
    process.exit(2);
  }

  if (APPLY) {
    await locations.createIndex(
      { businessId: 1 },
      {
        unique: true,
        name: INDEX_NAME,
        partialFilterExpression: {
          businessId: { $exists: true, $type: "objectId" },
        },
      }
    );
    const after = await locations.indexes();
    const created = after.find((idx) => idx.name === INDEX_NAME);
    if (!created?.unique) {
      console.error(
        "INDEX_CREATE_INCOMPLETE: index missing or not unique after createIndex."
      );
      await mongoose.disconnect();
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          applied: true,
          constraintActive: true,
          indexName: INDEX_NAME,
        },
        null,
        2
      )
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(
    "MIGRATE_ERROR",
    err instanceof Error ? err.message : "unknown"
  );
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
