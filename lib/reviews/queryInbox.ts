import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { FakeReviewFlag } from "@/models/FakeReviewFlag";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";

export type ReviewInboxReplyStatus =
  | "any"
  | "unreplied"
  | "replied"
  | "draft"
  | "approved"
  /** Unreplied reviews with a generated/edited/approved draft. */
  | "drafts";

export type ReviewInboxFilters = {
  businessIds: string[];
  groupId?: string | null;
  businessId?: string | null;
  locationId?: string | null;
  starRating?: number | null;
  replyStatus?: ReviewInboxReplyStatus;
  flagged?: boolean | null;
  /** Case-insensitive search on reviewer name and comment. */
  q?: string | null;
  from?: Date | null;
  to?: Date | null;
  page?: number;
  pageSize?: number;
};

export type ReviewInboxItem = {
  id: string;
  businessId: string | null;
  locationId: string;
  locationTitle: string;
  reviewerDisplayName: string;
  starRating: number | null;
  comment: string;
  createTime: string | null;
  updateTime: string | null;
  replyComment: string;
  replyUpdateTime: string | null;
  replySource: string;
  draftText: string;
  draftStatus: string;
  draftApproved: boolean;
  draftUpdatedAt: string | null;
  flagged: boolean;
};

export type ReviewInboxMetrics = {
  total: number;
  unreplied: number;
  draftsPending: number;
  published: number;
};

const UNREPLIED_CLAUSE = {
  $or: [
    { replyComment: { $exists: false } },
    { replyComment: "" },
    { replyComment: null },
  ],
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveScopeIds(
  filters: Pick<
    ReviewInboxFilters,
    "businessIds" | "groupId" | "businessId"
  >
): Promise<string[]> {
  const allowed = filters.businessIds.filter((id) =>
    mongoose.isValidObjectId(id)
  );
  if (allowed.length === 0) return [];

  let scopeIds = allowed;
  if (filters.groupId && mongoose.isValidObjectId(filters.groupId)) {
    const inGroup = await Business.find({
      _id: { $in: allowed },
      groupId: filters.groupId,
    })
      .select("_id")
      .lean();
    scopeIds = inGroup.map((b) => String(b._id));
  }
  if (filters.businessId && mongoose.isValidObjectId(filters.businessId)) {
    if (!scopeIds.includes(filters.businessId)) return [];
    scopeIds = [filters.businessId];
  }
  return scopeIds;
}

function buildReviewQuery(
  scopeIds: string[],
  filters: ReviewInboxFilters
): Record<string, unknown> {
  const query: Record<string, unknown> = {
    businessId: { $in: scopeIds },
  };
  const and: Record<string, unknown>[] = [];

  if (
    filters.locationId &&
    mongoose.isValidObjectId(filters.locationId)
  ) {
    query.locationId = filters.locationId;
  }

  if (
    typeof filters.starRating === "number" &&
    filters.starRating >= 1 &&
    filters.starRating <= 5
  ) {
    query.starRating = filters.starRating;
  }

  if (filters.replyStatus === "unreplied") {
    and.push(UNREPLIED_CLAUSE);
  } else if (filters.replyStatus === "replied") {
    query.replyComment = { $exists: true, $nin: ["", null] };
  } else if (filters.replyStatus === "draft") {
    query.draftStatus = { $in: ["generated", "edited"] };
  } else if (filters.replyStatus === "approved") {
    query.draftApproved = true;
    query.draftStatus = "approved";
  } else if (filters.replyStatus === "drafts") {
    query.draftStatus = { $in: ["generated", "edited", "approved"] };
    and.push(UNREPLIED_CLAUSE);
  }

  if (filters.from || filters.to) {
    const range: Record<string, Date> = {};
    if (filters.from) range.$gte = filters.from;
    if (filters.to) range.$lte = filters.to;
    query.createTime = range;
  }

  const q = filters.q?.trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    and.push({
      $or: [{ comment: rx }, { reviewerDisplayName: rx }],
    });
  }

  if (and.length === 1) {
    Object.assign(query, and[0]);
  } else if (and.length > 1) {
    query.$and = and;
  }

  return query;
}

/**
 * Aggregate counts for Reviews workspace metrics.
 * Caller must supply already-authorized businessIds.
 */
export async function countReviewInboxMetrics(input: {
  businessIds: string[];
  businessId?: string | null;
  groupId?: string | null;
}): Promise<ReviewInboxMetrics> {
  const scopeIds = await resolveScopeIds(input);
  if (scopeIds.length === 0) {
    return { total: 0, unreplied: 0, draftsPending: 0, published: 0 };
  }

  await connectToDatabase();
  const base = { businessId: { $in: scopeIds } };

  const [total, unreplied, draftsPending, published] = await Promise.all([
    Review.countDocuments(base),
    Review.countDocuments({ ...base, ...UNREPLIED_CLAUSE }),
    Review.countDocuments({
      ...base,
      draftStatus: { $in: ["generated", "edited", "approved"] },
      ...UNREPLIED_CLAUSE,
    }),
    Review.countDocuments({
      ...base,
      replyComment: { $exists: true, $nin: ["", null] },
    }),
  ]);

  return { total, unreplied, draftsPending, published };
}

/**
 * Query reviews for Business Admin / Super Admin inbox.
 * Caller must supply already-authorized businessIds — never trusts client alone.
 */
export async function queryReviewInbox(
  filters: ReviewInboxFilters
): Promise<{
  reviews: ReviewInboxItem[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, filters.page || 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize || 25));
  const scopeIds = await resolveScopeIds(filters);
  if (scopeIds.length === 0) {
    return { reviews: [], total: 0, page, pageSize };
  }

  await connectToDatabase();

  const query = buildReviewQuery(scopeIds, filters);

  if (filters.flagged === true) {
    const flags = await FakeReviewFlag.find({
      businessId: { $in: scopeIds },
      status: { $in: ["open", "investigating", "confirmed_suspicious"] },
    })
      .select("reviewId")
      .lean();
    const reviewIds = flags.map((f) => f.reviewId);
    if (reviewIds.length === 0) {
      return { reviews: [], total: 0, page, pageSize };
    }
    query._id = { $in: reviewIds };
  } else if (filters.flagged === false) {
    const flags = await FakeReviewFlag.find({
      businessId: { $in: scopeIds },
      status: { $in: ["open", "investigating", "confirmed_suspicious"] },
    })
      .select("reviewId")
      .lean();
    if (flags.length > 0) {
      query._id = { $nin: flags.map((f) => f.reviewId) };
    }
  }

  const [total, rows] = await Promise.all([
    Review.countDocuments(query),
    Review.find(query)
      .sort({ updateTime: -1, createTime: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);

  const rowIds = rows.map((r) => r._id);
  const locationIds = [
    ...new Set(rows.map((r) => String(r.locationId)).filter(Boolean)),
  ];

  const [openFlags, locations] = await Promise.all([
    rowIds.length
      ? FakeReviewFlag.find({
          reviewId: { $in: rowIds },
          status: { $in: ["open", "investigating", "confirmed_suspicious"] },
        })
          .select("reviewId")
          .lean()
      : Promise.resolve([]),
    locationIds.length
      ? Location.find({ _id: { $in: locationIds } })
          .select("_id title googleLocationName")
          .lean()
      : Promise.resolve([]),
  ]);

  const flaggedSet = new Set(openFlags.map((f) => String(f.reviewId)));
  const locationTitleById = new Map(
    locations.map((loc) => [
      String(loc._id),
      loc.title || loc.googleLocationName || "",
    ])
  );

  return {
    total,
    page,
    pageSize,
    reviews: rows.map((r) => ({
      id: String(r._id),
      businessId: r.businessId ? String(r.businessId) : null,
      locationId: String(r.locationId),
      locationTitle: locationTitleById.get(String(r.locationId)) || "",
      reviewerDisplayName: r.reviewerDisplayName || "",
      starRating: typeof r.starRating === "number" ? r.starRating : null,
      comment: r.comment || "",
      createTime: r.createTime ? new Date(r.createTime).toISOString() : null,
      updateTime: r.updateTime ? new Date(r.updateTime).toISOString() : null,
      replyComment: r.replyComment || "",
      replyUpdateTime: r.replyUpdateTime
        ? new Date(r.replyUpdateTime).toISOString()
        : null,
      replySource: r.replySource || "",
      draftText: r.draftText || "",
      draftStatus: r.draftStatus || "",
      draftApproved: Boolean(r.draftApproved),
      draftUpdatedAt: r.draftUpdatedAt
        ? new Date(r.draftUpdatedAt).toISOString()
        : null,
      flagged: flaggedSet.has(String(r._id)),
    })),
  };
}
