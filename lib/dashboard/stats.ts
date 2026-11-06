import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { AutoPublishJob } from "@/models/AutoPublishJob";
import { GoogleConnection } from "@/models/GoogleConnection";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";
import type { AuthUser } from "@/lib/auth/authorize";
import type { DashboardStats } from "@/types";

const EMPTY_STATS: DashboardStats = {
  connectedLocations: 0,
  pendingReviews: 0,
  publishedReplies: 0,
  googleSyncedReplies: 0,
  reviewCount: 0,
  averageRating: null,
  locationTitle: null,
  googleConnectionStatus: "missing",
  draftsAwaitingApproval: 0,
  failedReplies: 0,
};

/** TRONX-confirmed publish only — never every non-empty replyComment. */
const TRONX_PUBLISHED_FILTER = {
  $or: [
    { replySource: "tronx_published" as const },
    { tronxPublishedAt: { $exists: true, $ne: null } },
  ],
};

const GOOGLE_SYNCED_REPLY_FILTER = {
  replySource: "google_synced" as const,
  replyComment: { $exists: true, $nin: ["", null] },
};

async function connectionStatusForOrg(
  orgId: string
): Promise<DashboardStats["googleConnectionStatus"]> {
  const conn = await GoogleConnection.findOne({
    orgId,
    status: { $in: ["active", "error"] },
  })
    .select("status")
    .lean();
  if (!conn) return "missing";
  if (conn.status === "active") return "connected";
  if (conn.status === "error") return "error";
  return "missing";
}

/**
 * Counts from stored Mongo documents only.
 * Requires a signed-in user — org cookie alone never authorizes metrics.
 * When businessId is provided, counts are limited to that business (after
 * caller has verified access). Otherwise owners are scoped to all of their
 * active assigned locations in the org.
 */
export async function getDashboardStats(input: {
  orgId: string | null;
  user: AuthUser | null;
  businessId?: string | null;
}): Promise<DashboardStats> {
  const { orgId, user, businessId } = input;
  if (!orgId || !user || !mongoose.isValidObjectId(orgId)) {
    return { ...EMPTY_STATS };
  }

  await connectToDatabase();

  let locationFilter: Record<string, unknown> = { orgId };
  let reviewFilter: Record<string, unknown> = { orgId };

  if (businessId) {
    if (!mongoose.isValidObjectId(businessId)) return { ...EMPTY_STATS };
    locationFilter = { orgId, businessId };
    reviewFilter = { orgId, businessId };
  } else if (user.role !== "superadmin") {
    const assigned = await Location.find({
      orgId,
      businessId: { $in: user.businessIds },
    })
      .select("_id")
      .lean();
    const locationIds = assigned.map((d) => d._id);
    if (locationIds.length === 0) {
      const googleConnectionStatus = await connectionStatusForOrg(orgId);
      return { ...EMPTY_STATS, googleConnectionStatus };
    }
    locationFilter = { orgId, _id: { $in: locationIds } };
    reviewFilter = { orgId, locationId: { $in: locationIds } };
  }

  const draftsFilter =
    businessId && mongoose.isValidObjectId(businessId)
      ? {
          businessId,
          status: "awaiting_approval" as const,
        }
      : null;

  const [
    connectedLocations,
    publishedReplies,
    googleSyncedReplies,
    reviewCount,
    ratingAgg,
    locations,
    googleConnectionStatus,
    failedReplies,
    jobDrafts,
    reviewDrafts,
  ] = await Promise.all([
    Location.countDocuments(locationFilter),
    Review.countDocuments({
      ...reviewFilter,
      ...TRONX_PUBLISHED_FILTER,
    }),
    Review.countDocuments({
      ...reviewFilter,
      ...GOOGLE_SYNCED_REPLY_FILTER,
    }),
    Review.countDocuments(reviewFilter),
    Review.aggregate<{ _id: null; avg: number; n: number }>([
      {
        $match: {
          ...reviewFilter,
          starRating: { $type: "number" },
        },
      },
      {
        $group: {
          _id: null,
          avg: { $avg: "$starRating" },
          n: { $sum: 1 },
        },
      },
    ]),
    Location.find(locationFilter)
      .select("title googleLocationName")
      .limit(2)
      .lean(),
    connectionStatusForOrg(orgId),
    Review.countDocuments({
      ...reviewFilter,
      lastPublishError: { $exists: true, $nin: ["", null] },
    }),
    draftsFilter
      ? AutoPublishJob.countDocuments(draftsFilter)
      : Promise.resolve(0),
    Review.countDocuments({
      ...reviewFilter,
      draftStatus: { $in: ["generated", "edited", "approved"] },
      $or: [
        { replySource: { $ne: "tronx_published" as const } },
        { replySource: { $exists: false } },
      ],
      tronxPublishedAt: null,
    }),
  ]);

  const draftsAwaitingApproval = jobDrafts + reviewDrafts;
  const pendingReviews = Math.max(
    0,
    reviewCount - publishedReplies - googleSyncedReplies
  );
  const ratingRow = ratingAgg[0];
  const averageRating =
    ratingRow && ratingRow.n > 0 && typeof ratingRow.avg === "number"
      ? Math.round(ratingRow.avg * 10) / 10
      : null;

  let locationTitle: string | null = null;
  if (locations.length === 1) {
    const loc = locations[0];
    locationTitle =
      (loc.title && String(loc.title).trim()) ||
      loc.googleLocationName ||
      null;
  }

  return {
    connectedLocations,
    pendingReviews,
    publishedReplies,
    googleSyncedReplies,
    reviewCount,
    averageRating,
    locationTitle,
    googleConnectionStatus,
    draftsAwaitingApproval,
    failedReplies,
  };
}
