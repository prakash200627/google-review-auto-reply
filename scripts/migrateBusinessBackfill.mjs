/**
 * Safe, repeatable migration helper for multi-business association.
 *
 * Default: dry-run (no writes). Reports unassigned locations/reviews.
 * Does NOT invent businesses or auto-assign Google locations.
 *
 * Usage:
 *   node --env-file=.env.local scripts/migrateBusinessBackfill.mjs
 *   ALLOW_MIGRATE_APPLY=1 node --env-file=.env.local scripts/migrateBusinessBackfill.mjs --apply
 *
 * --apply only ensures indexes. It never rewrites ownership.
 * Use a non-production MONGODB_URI. --apply also requires ALLOW_MIGRATE_APPLY=1.
 */
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
const allowApply = process.env.ALLOW_MIGRATE_APPLY === "1";

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
  const db = mongoose.connection;

  const locations = db.collection("locations");
  const reviews = db.collection("reviews");
  const businesses = db.collection("businesses");

  const unassignedLocations = await locations.countDocuments({
    $or: [{ businessId: null }, { businessId: { $exists: false } }],
  });
  const unassignedReviews = await reviews.countDocuments({
    $or: [{ businessId: null }, { businessId: { $exists: false } }],
  });
  const businessCount = await businesses.countDocuments({});

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        businessCount,
        unassignedLocations,
        unassignedReviews,
        note: "No automatic location→business assignment is performed. Super Admin must assign locations explicitly. Re-running is safe.",
      },
      null,
      2
    )
  );

  if (APPLY) {
    // Ensure indexes exist; do not rewrite ownership.
    await locations.createIndex({ businessId: 1 });
    await reviews.createIndex({ businessId: 1 });
    console.log("Indexes ensured for businessId on locations and reviews.");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("MIGRATE_ERROR", err instanceof Error ? err.message : "unknown");
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
