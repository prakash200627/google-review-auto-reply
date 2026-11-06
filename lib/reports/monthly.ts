/**
 * Business-scoped monthly report metrics from stored documents only.
 * Never invents historical values — missing data surfaces as unavailable.
 */

import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Review } from "@/models/Review";

export type MonthlyReport = {
  businessId: string;
  periodKey: string;
  from: string;
  to: string;
  reviewCount: number;
  averageRating: number | null;
  tronxPublishedReplies: number;
  googleSyncedReplies: number;
  draftsGenerated: number;
  draftsApproved: number;
  failedPublishes: number;
  ratingTrend: Array<{ starRating: number; count: number }>;
  notes: string[];
};

function periodBounds(periodKey: string): { from: Date; to: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(periodKey)) return null;
  const [y, m] = periodKey.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from, to };
}

export function currentPeriodKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function buildMonthlyReport(input: {
  businessId: string;
  periodKey?: string;
}): Promise<MonthlyReport | null> {
  const businessId = input.businessId;
  if (!mongoose.isValidObjectId(businessId)) return null;
  const periodKey = input.periodKey || currentPeriodKey();
  const bounds = periodBounds(periodKey);
  if (!bounds) return null;

  await connectToDatabase();
  const timeFilter = {
    createTime: { $gte: bounds.from, $lt: bounds.to },
  };
  const base = { businessId, ...timeFilter };

  const [
    reviewCount,
    ratingAgg,
    tronxPublishedReplies,
    googleSyncedReplies,
    draftsGenerated,
    draftsApproved,
    failedPublishes,
    ratingTrend,
  ] = await Promise.all([
    Review.countDocuments(base),
    Review.aggregate<{ _id: null; avg: number; n: number }>([
      { $match: { ...base, starRating: { $type: "number" } } },
      { $group: { _id: null, avg: { $avg: "$starRating" }, n: { $sum: 1 } } },
    ]),
    Review.countDocuments({
      businessId,
      tronxPublishedAt: { $gte: bounds.from, $lt: bounds.to },
    }),
    Review.countDocuments({
      ...base,
      replySource: "google_synced" as const,
      replyComment: { $exists: true, $nin: ["", null] },
    }),
    Review.countDocuments({
      businessId,
      draftGeneratedAt: { $gte: bounds.from, $lt: bounds.to },
    }),
    Review.countDocuments({
      businessId,
      draftStatus: "approved",
      draftUpdatedAt: { $gte: bounds.from, $lt: bounds.to },
    }),
    Review.countDocuments({
      ...base,
      lastPublishError: { $exists: true, $nin: ["", null] },
    }),
    Review.aggregate<{ _id: number; count: number }>([
      { $match: { ...base, starRating: { $type: "number" } } },
      { $group: { _id: "$starRating", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const ratingRow = ratingAgg[0];
  const averageRating =
    ratingRow && ratingRow.n > 0 && typeof ratingRow.avg === "number"
      ? Math.round(ratingRow.avg * 10) / 10
      : null;

  const notes: string[] = [];
  if (reviewCount === 0) {
    notes.push(
      "No reviews with createTime in this period were found. Older synced reviews without createTime are not included."
    );
  }

  return {
    businessId,
    periodKey,
    from: bounds.from.toISOString(),
    to: bounds.to.toISOString(),
    reviewCount,
    averageRating,
    tronxPublishedReplies,
    googleSyncedReplies,
    draftsGenerated,
    draftsApproved,
    failedPublishes,
    ratingTrend: ratingTrend.map((r) => ({
      starRating: r._id,
      count: r.count,
    })),
    notes,
  };
}
