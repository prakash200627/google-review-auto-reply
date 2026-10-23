#!/usr/bin/env node
// Read-only audit: lists Location documents that share a googleLocationId.
// It never writes, deletes, or builds indexes. Run manually:
//   cd backend && node scripts/findDuplicateLocations.js > duplicate-locations.json

const mongoose = require("mongoose");

// Groups on the trimmed ID so values differing only by whitespace are reported together.
function duplicateLocationPipeline() {
    return [
        {
            $group: {
                _id: { $trim: { input: { $toString: "$googleLocationId" } } },
                count: { $sum: 1 },
                orgIds: { $addToSet: "$orgId" },
                locations: {
                    $push: {
                        _id: "$_id",
                        orgId: "$orgId",
                        name: "$name",
                        googleLocationId: "$googleLocationId",
                        createdAt: "$createdAt",
                    },
                },
            },
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1, _id: 1 } },
    ];
}

function summarizeDuplicates(groups, reviewCounts = new Map()) {
    return groups.map((group) => ({
        googleLocationId: group._id,
        count: group.count,
        crossOrganization: group.orgIds.length > 1,
        locations: group.locations
            .map((loc) => ({
                ...loc,
                _id: String(loc._id),
                orgId: String(loc.orgId),
                reviewCount: reviewCounts.get(String(loc._id)) || 0,
            }))
            .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)),
    }));
}

async function main() {
    require("dotenv").config({ quiet: true });
    if (!process.env.MONGO_URI) {
        console.error("MONGO_URI is not set");
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    try {
        const db = mongoose.connection.db;
        const groups = await db.collection("locations").aggregate(duplicateLocationPipeline()).toArray();

        const locationIds = groups.flatMap((g) => g.locations.map((l) => l._id));
        const counts = locationIds.length
            ? await db.collection("reviews").aggregate([
                { $match: { locationId: { $in: locationIds } } },
                { $group: { _id: "$locationId", n: { $sum: 1 } } },
            ]).toArray()
            : [];
        const reviewCounts = new Map(counts.map((c) => [String(c._id), c.n]));

        const report = summarizeDuplicates(groups, reviewCounts);
        console.log(JSON.stringify({
            checkedAt: new Date().toISOString(),
            duplicateGroups: report.length,
            crossOrganizationGroups: report.filter((g) => g.crossOrganization).length,
            groups: report,
        }, null, 2));
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error("Duplicate location audit failed:", err.message);
        process.exit(1);
    });
}

module.exports = { duplicateLocationPipeline, summarizeDuplicates };
