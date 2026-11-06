import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { resolveBusinessLifecycle } from "@/lib/business/lifecycle";
import { Business } from "@/models/Business";
import { GoogleConnection } from "@/models/GoogleConnection";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";

const TRONX_PUBLISHED_FILTER = {
  $or: [
    { replySource: "tronx_published" as const },
    { tronxPublishedAt: { $exists: true, $ne: null } },
  ],
};

export type BusinessStatsRow = {
  id: string;
  name: string;
  active: boolean;
  status: string;
  replyMode: string;
  locationCount: number;
  reviewCount: number;
  pendingReviews: number;
  /** TRONX-confirmed publications only. */
  publishedReplies: number;
  googleSyncedReplies: number;
  /** Mean of numeric starRating values; null when no rated reviews. */
  averageRating: number | null;
  googleConnected: boolean;
  lastSyncError: string;
  lastPublishError: string;
};

export type AdminAggregateStats = {
  totalBusinesses: number;
  activeBusinesses: number;
  suspendedBusinesses: number;
  archivedBusinesses: number;
  /** @deprecated Prefer suspendedBusinesses + archivedBusinesses */
  inactiveBusinesses: number;
  totalLocations: number;
  unassignedLocations: number;
  totalReviews: number;
  unassignedReviews: number;
  /** Platform operational: TRONX-confirmed publishes only (not customer aggregates of all replies). */
  publishedReplies: number;
  googleSyncedReplies: number;
  pendingReviews: number;
  businesses: BusinessStatsRow[];
};

type ReviewBizAgg = {
  _id: mongoose.Types.ObjectId;
  reviewCount: number;
  published: number;
  synced: number;
  ratingSum: number;
  ratingN: number;
};

/**
 * Platform admin aggregate stats.
 * Uses bounded parallel collection counts + one review aggregation by businessId
 * (avoids per-business N+1 count/aggregate/connection lookups).
 */
export async function getAdminAggregateStats(): Promise<AdminAggregateStats> {
  await connectToDatabase();

  const businesses = await Business.find({}).sort({ name: 1 }).lean();
  const businessIds = businesses.map((b) => b._id);
  const orgIds = [
    ...new Set(
      businesses
        .map((b) => (b.orgId ? String(b.orgId) : null))
        .filter((id): id is string => Boolean(id))
    ),
  ].filter((id) => mongoose.isValidObjectId(id));

  const [
    totalLocations,
    unassignedLocations,
    totalReviews,
    unassignedReviews,
    publishedReplies,
    googleSyncedReplies,
    perBusinessAgg,
    activeConnections,
  ] = await Promise.all([
    Location.countDocuments({}),
    Location.countDocuments({
      $or: [{ businessId: null }, { businessId: { $exists: false } }],
    }),
    Review.countDocuments({}),
    Review.countDocuments({
      $or: [{ businessId: null }, { businessId: { $exists: false } }],
    }),
    Review.countDocuments(TRONX_PUBLISHED_FILTER),
    Review.countDocuments({
      replySource: "google_synced" as const,
      replyComment: { $exists: true, $nin: ["", null] },
    }),
    businessIds.length === 0
      ? Promise.resolve([] as ReviewBizAgg[])
      : (Review.aggregate<ReviewBizAgg>([
          { $match: { businessId: { $in: businessIds } } },
          {
            $group: {
              _id: "$businessId",
              reviewCount: { $sum: 1 },
              published: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$replySource", "tronx_published"] },
                        {
                          $and: [
                            { $ne: ["$tronxPublishedAt", null] },
                            {
                              $ne: [
                                { $type: "$tronxPublishedAt" },
                                "missing",
                              ],
                            },
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              synced: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$replySource", "google_synced"] },
                        { $ne: ["$replyComment", null] },
                        { $ne: ["$replyComment", ""] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              ratingSum: {
                $sum: {
                  $cond: [{ $isNumber: "$starRating" }, "$starRating", 0],
                },
              },
              ratingN: {
                $sum: {
                  $cond: [{ $isNumber: "$starRating" }, 1, 0],
                },
              },
            },
          },
        ]) as Promise<ReviewBizAgg[]>),
    orgIds.length === 0
      ? Promise.resolve([] as { orgId: mongoose.Types.ObjectId }[])
      : GoogleConnection.find({
          orgId: { $in: orgIds },
          status: "active",
        })
          .select("orgId")
          .lean(),
  ]);

  const aggByBiz = new Map(
    perBusinessAgg.map((row) => [String(row._id), row])
  );
  const connectedOrgs = new Set(
    activeConnections.map((c) => String(c.orgId))
  );

  const rows: BusinessStatsRow[] = businesses.map((biz) => {
    const businessId = biz._id;
    const status = resolveBusinessLifecycle(biz);
    const agg = aggByBiz.get(String(businessId));
    const reviewCount = agg?.reviewCount ?? 0;
    const published = agg?.published ?? 0;
    const synced = agg?.synced ?? 0;
    const ratingN = agg?.ratingN ?? 0;
    const averageRating =
      ratingN > 0 && agg
        ? Math.round((agg.ratingSum / ratingN) * 10) / 10
        : null;

    return {
      id: String(businessId),
      name: biz.name,
      active: status === "active",
      status,
      replyMode: biz.replyMode || "manual",
      locationCount: (biz.locationIds || []).length,
      reviewCount,
      pendingReviews: Math.max(0, reviewCount - published - synced),
      publishedReplies: published,
      googleSyncedReplies: synced,
      averageRating,
      googleConnected: biz.orgId
        ? connectedOrgs.has(String(biz.orgId))
        : false,
      lastSyncError: biz.lastSyncError || "",
      lastPublishError: biz.lastPublishError || "",
    };
  });

  const activeBusinesses = businesses.filter(
    (b) => resolveBusinessLifecycle(b) === "active"
  ).length;
  const suspendedBusinesses = businesses.filter(
    (b) => resolveBusinessLifecycle(b) === "suspended"
  ).length;
  const archivedBusinesses = businesses.filter(
    (b) => resolveBusinessLifecycle(b) === "archived"
  ).length;

  return {
    totalBusinesses: businesses.length,
    activeBusinesses,
    suspendedBusinesses,
    archivedBusinesses,
    inactiveBusinesses: suspendedBusinesses + archivedBusinesses,
    totalLocations,
    unassignedLocations,
    totalReviews,
    unassignedReviews,
    publishedReplies,
    googleSyncedReplies,
    pendingReviews: Math.max(
      0,
      totalReviews - publishedReplies - googleSyncedReplies
    ),
    businesses: rows,
  };
}

/**
 * After Super Admin assigns locations to a business, backfill review.businessId
 * only for those location IDs — never invents ownership for unassigned rows.
 * Location.businessId is the assignment source of truth; this keeps Review in sync.
 */
export async function syncReviewBusinessIdsForLocations(input: {
  businessId: string;
  locationIds: string[];
  session?: import("mongoose").ClientSession | null;
}): Promise<number> {
  const { businessId, locationIds, session } = input;
  if (
    !mongoose.isValidObjectId(businessId) ||
    locationIds.some((id) => !mongoose.isValidObjectId(id))
  ) {
    return 0;
  }
  await connectToDatabase();
  if (locationIds.length === 0) return 0;

  // Only backfill reviews whose locations are currently assigned to this business.
  const assignedQuery = Location.find({
    _id: { $in: locationIds },
    businessId,
  }).select("_id");
  if (session) assignedQuery.session(session);
  const assigned = await assignedQuery.lean();
  const assignedIds = assigned.map((l) => l._id);
  if (assignedIds.length === 0) return 0;

  const result = session
    ? await Review.updateMany(
        { locationId: { $in: assignedIds } },
        { $set: { businessId } },
        { session }
      )
    : await Review.updateMany(
        { locationId: { $in: assignedIds } },
        { $set: { businessId } }
      );
  return result.modifiedCount || 0;
}

/**
 * Clear review.businessId for locations removed from a business so owners
 * cannot keep access via stale review associations.
 */
export async function clearReviewBusinessIdsForLocations(input: {
  businessId: string;
  locationIds: string[];
  session?: import("mongoose").ClientSession | null;
}): Promise<number> {
  const { businessId, locationIds, session } = input;
  if (
    !mongoose.isValidObjectId(businessId) ||
    locationIds.length === 0 ||
    locationIds.some((id) => !mongoose.isValidObjectId(id))
  ) {
    return 0;
  }
  await connectToDatabase();
  const filter = {
    businessId,
    locationId: { $in: locationIds },
  };
  const update = { $set: { businessId: null } };
  const result = session
    ? await Review.updateMany(filter, update, { session })
    : await Review.updateMany(filter, update);
  return result.modifiedCount || 0;
}
