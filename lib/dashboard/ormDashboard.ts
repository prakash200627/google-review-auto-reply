import mongoose from "mongoose";
import {
  assertBusinessAccess,
  listActiveBusinessIdsForUser,
  type AuthUser,
} from "@/lib/auth/authorize";
import { assertGroupAccess } from "@/lib/auth/assertGroupAccess";
import { assertSuperAdminActiveOrgMatches } from "@/lib/auth/resolveOrgContext";
import { resolveBusinessLifecycle } from "@/lib/business/lifecycle";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";
import { Location } from "@/models/Location";
import { Review } from "@/models/Review";

const UNREPLIED = {
  $or: [
    { replyComment: { $exists: false } },
    { replyComment: "" },
    { replyComment: null },
  ],
};

const PUBLISHED = {
  replyComment: { $exists: true, $nin: ["", null] },
};

const DRAFT_PENDING_STATUSES = ["generated", "edited", "approved"] as const;

const DRAFTS_PENDING = {
  draftStatus: { $in: [...DRAFT_PENDING_STATUSES] },
  ...UNREPLIED,
};

export type RatingBucket = { stars: number; count: number };

export type LocationReviewStat = {
  locationId: string;
  title: string;
  reviewCount: number;
  unanswered: number;
  averageRating: number | null;
};

export type RecentReviewRow = {
  id: string;
  businessId: string | null;
  businessName?: string;
  locationTitle: string;
  reviewerDisplayName: string;
  starRating: number | null;
  comment: string;
  createTime: string | null;
  hasReply: boolean;
  draftStatus: string;
};

export type BusinessDashboardPayload = {
  business: {
    id: string;
    name: string;
    status: string;
    active: boolean;
    groupId: string | null;
    groupName: string | null;
    orgId: string;
    brandVoice: string;
    preferredLanguage: string;
    replyToneNotes: string;
    phone: string;
    replyMode: string;
  };
  metrics: {
    totalReviews: number;
    averageRating: number | null;
    unanswered: number;
    draftsPending: number;
    publishedReplies: number;
    locationCount: number;
    tronxPublished: number;
    googleSyncedReplies: number;
    failedReplies: number;
  };
  ratingDistribution: RatingBucket[];
  byLocation: LocationReviewStat[];
  recentReviews: RecentReviewRow[];
  reviewsHref: string;
};

export type GroupBusinessComparison = {
  businessId: string;
  name: string;
  status: string;
  totalReviews: number;
  unanswered: number;
  draftsPending: number;
  publishedReplies: number;
  averageRating: number | null;
};

export type GroupDashboardPayload = {
  group: {
    id: string;
    name: string;
    description: string;
    active: boolean;
    orgId: string;
  };
  metrics: {
    businessCount: number;
    totalReviews: number;
    averageRating: number | null;
    unanswered: number;
    draftsPending: number;
    publishedReplies: number;
    locationCount: number;
  };
  ratingDistribution: RatingBucket[];
  businesses: GroupBusinessComparison[];
  locations: Array<{
    locationId: string;
    title: string;
    businessId: string | null;
    businessName: string | null;
  }>;
  recentReviews: RecentReviewRow[];
  reviewsHref: string;
};

export type OrmLandingPayload = {
  businesses: Array<{ id: string; name: string; groupId: string | null }>;
  groups: Array<{ id: string; name: string; businessCount: number }>;
  singleBusinessId: string | null;
  /** Active organization used for SA scoping (null when unset). */
  orgId: string | null;
  /** SA must pick an org session before landing selectors can load. */
  needsOrgSelection: boolean;
};

function toObjectIds(ids: string[]): mongoose.Types.ObjectId[] {
  return ids
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

function serializeBusinessChoices(
  rows: Array<{ _id: unknown; name?: string; groupId?: unknown }>
): OrmLandingPayload["businesses"] {
  return rows.map((b) => ({
    id: String(b._id),
    name: b.name || "Business",
    groupId: b.groupId ? String(b.groupId) : null,
  }));
}

function emptyRatingDistribution(): RatingBucket[] {
  return [5, 4, 3, 2, 1].map((stars) => ({ stars, count: 0 }));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Aggregations do not apply Mongoose cast the way find/count do.
 * Normalize businessId filters to ObjectIds so metrics match countDocuments.
 * Exported for regression tests.
 */
export function asAggregateReviewFilter(
  reviewFilter: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...reviewFilter };
  const biz = out.businessId;
  if (typeof biz === "string" && mongoose.isValidObjectId(biz)) {
    out.businessId = new mongoose.Types.ObjectId(biz);
    return out;
  }
  if (biz && typeof biz === "object" && biz !== null && "$in" in biz) {
    const list = (biz as { $in: unknown }).$in;
    if (Array.isArray(list)) {
      out.businessId = {
        $in: list.map((id) =>
          typeof id === "string" && mongoose.isValidObjectId(id)
            ? new mongoose.Types.ObjectId(id)
            : id
        ),
      };
    }
  }
  return out;
}

async function ratingDistributionForFilter(
  reviewFilter: Record<string, unknown>
): Promise<RatingBucket[]> {
  const rows = await Review.aggregate<{ _id: number; count: number }>([
    {
      $match: {
        ...asAggregateReviewFilter(reviewFilter),
        starRating: { $type: "number", $gte: 1, $lte: 5 },
      },
    },
    { $group: { _id: "$starRating", count: { $sum: 1 } } },
  ]);
  const map = new Map(rows.map((r) => [r._id, r.count]));
  return emptyRatingDistribution().map((b) => ({
    stars: b.stars,
    count: map.get(b.stars) || 0,
  }));
}

async function averageRatingForFilter(
  reviewFilter: Record<string, unknown>
): Promise<number | null> {
  const agg = await Review.aggregate<{ avg: number; n: number }>([
    {
      $match: {
        ...asAggregateReviewFilter(reviewFilter),
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
  ]);
  const row = agg[0];
  if (!row || row.n <= 0 || typeof row.avg !== "number") return null;
  return round1(row.avg);
}

async function recentReviewsForBusinessIds(
  businessIds: string[],
  limit = 8
): Promise<RecentReviewRow[]> {
  if (businessIds.length === 0) return [];
  const rows = await Review.find({ businessId: { $in: businessIds } })
    .sort({ createTime: -1, updateTime: -1 })
    .limit(limit)
    .select(
      "businessId locationId reviewerDisplayName starRating comment createTime replyComment draftStatus"
    )
    .lean();

  const locIds = [...new Set(rows.map((r) => String(r.locationId)))];
  const bizIds = [
    ...new Set(
      rows
        .map((r) => (r.businessId ? String(r.businessId) : null))
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const [locs, biz] = await Promise.all([
    locIds.length
      ? Location.find({ _id: { $in: locIds } })
          .select("title googleLocationName")
          .lean()
      : Promise.resolve([]),
    bizIds.length
      ? Business.find({ _id: { $in: bizIds } })
          .select("name")
          .lean()
      : Promise.resolve([]),
  ]);
  const locTitle = new Map(
    locs.map((l) => [
      String(l._id),
      l.title || l.googleLocationName || "",
    ])
  );
  const bizName = new Map(biz.map((b) => [String(b._id), b.name || "Business"]));

  return rows.map((r) => ({
    id: String(r._id),
    businessId: r.businessId ? String(r.businessId) : null,
    businessName: r.businessId
      ? bizName.get(String(r.businessId)) || undefined
      : undefined,
    locationTitle: locTitle.get(String(r.locationId)) || "",
    reviewerDisplayName: r.reviewerDisplayName || "Anonymous",
    starRating: typeof r.starRating === "number" ? r.starRating : null,
    comment: r.comment || "",
    createTime: r.createTime ? new Date(r.createTime).toISOString() : null,
    hasReply: Boolean(r.replyComment?.trim()),
    draftStatus: r.draftStatus || "",
  }));
}

/**
 * Business ORM dashboard — caller must already hold AuthUser.
 * Authorization is enforced via assertBusinessAccess.
 */
export async function getBusinessOrmDashboard(
  user: AuthUser,
  businessId: string
): Promise<
  | { ok: true; data: BusinessDashboardPayload }
  | { ok: false; status: number; code: string; message: string }
> {
  const access = await assertBusinessAccess(user, businessId);
  if (!access.ok) {
    const body = await access.response.json().catch(() => ({}));
    return {
      ok: false,
      status: access.response.status,
      code: body.code || "forbidden",
      message: body.message || "Access denied",
    };
  }

  const orgGate = await assertSuperAdminActiveOrgMatches(
    user,
    access.business.orgId ? String(access.business.orgId) : null
  );
  if (!orgGate.ok) {
    return {
      ok: false,
      status: orgGate.status,
      code: orgGate.code,
      message: orgGate.message,
    };
  }

  await connectToDatabase();
  const biz = access.business;
  const id = String(biz._id);
  const reviewFilter = { businessId: id };
  const status = resolveBusinessLifecycle(biz);

  const groupId = biz.groupId ? String(biz.groupId) : null;
  const group =
    groupId && mongoose.isValidObjectId(groupId)
      ? await BusinessGroup.findById(groupId).select("name").lean()
      : null;

  const [
    totalReviews,
    unanswered,
    draftsPending,
    publishedReplies,
    locationCount,
    tronxPublished,
    googleSyncedReplies,
    failedReplies,
    averageRating,
    ratingDistribution,
    locDocs,
    recentReviews,
  ] = await Promise.all([
    Review.countDocuments(reviewFilter),
    Review.countDocuments({ ...reviewFilter, ...UNREPLIED }),
    Review.countDocuments({ ...reviewFilter, ...DRAFTS_PENDING }),
    Review.countDocuments({ ...reviewFilter, ...PUBLISHED }),
    Location.countDocuments({ businessId: id }),
    Review.countDocuments({
      ...reviewFilter,
      $or: [
        { replySource: "tronx_published" },
        { tronxPublishedAt: { $exists: true, $ne: null } },
      ],
    }),
    Review.countDocuments({
      ...reviewFilter,
      replySource: "google_synced",
      ...PUBLISHED,
    }),
    Review.countDocuments({
      ...reviewFilter,
      lastPublishError: { $exists: true, $nin: ["", null] },
    }),
    averageRatingForFilter(reviewFilter),
    ratingDistributionForFilter(reviewFilter),
    Location.find({ businessId: id })
      .select("title googleLocationName")
      .lean(),
    recentReviewsForBusinessIds([id], 8),
  ]);

  const byLocationAgg = await Review.aggregate<{
    _id: mongoose.Types.ObjectId;
    reviewCount: number;
    unanswered: number;
    ratingSum: number;
    ratingN: number;
  }>([
    { $match: { businessId: new mongoose.Types.ObjectId(id) } },
    {
      $group: {
        _id: "$locationId",
        reviewCount: { $sum: 1 },
        unanswered: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$replyComment", ""] },
                  { $eq: ["$replyComment", null] },
                  { $not: ["$replyComment"] },
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
  ]);

  const locTitle = new Map(
    locDocs.map((l) => [
      String(l._id),
      l.title || l.googleLocationName || "Location",
    ])
  );

  const byLocation: LocationReviewStat[] = byLocationAgg.map((row) => ({
    locationId: String(row._id),
    title: locTitle.get(String(row._id)) || "Location",
    reviewCount: row.reviewCount,
    unanswered: row.unanswered,
    averageRating:
      row.ratingN > 0 ? round1(row.ratingSum / row.ratingN) : null,
  }));

  // Include locations with zero reviews
  for (const loc of locDocs) {
    const lid = String(loc._id);
    if (!byLocation.some((r) => r.locationId === lid)) {
      byLocation.push({
        locationId: lid,
        title: locTitle.get(lid) || "Location",
        reviewCount: 0,
        unanswered: 0,
        averageRating: null,
      });
    }
  }
  byLocation.sort((a, b) => b.reviewCount - a.reviewCount);

  return {
    ok: true,
    data: {
      business: {
        id,
        name: biz.name || "Business",
        status,
        active: Boolean(biz.active !== false && status === "active"),
        groupId,
        groupName: group?.name || null,
        orgId: String(biz.orgId),
        brandVoice: biz.brandVoice || "friendly",
        preferredLanguage: biz.preferredLanguage || "English",
        replyToneNotes: biz.replyToneNotes || "",
        phone: biz.profile?.phone || "",
        replyMode: biz.replyMode || "manual",
      },
      metrics: {
        totalReviews,
        averageRating,
        unanswered,
        draftsPending,
        publishedReplies,
        locationCount,
        tronxPublished,
        googleSyncedReplies,
        failedReplies,
      },
      ratingDistribution,
      byLocation,
      recentReviews,
      reviewsHref: `/orm/reviews?businessId=${encodeURIComponent(id)}`,
    },
  };
}

/**
 * Group ORM dashboard — aggregates only Business.groupId members ∩ user access.
 */
export async function getGroupOrmDashboard(
  user: AuthUser,
  groupId: string
): Promise<
  | { ok: true; data: GroupDashboardPayload }
  | { ok: false; status: number; code: string; message: string }
> {
  const access = await assertGroupAccess(user, groupId);
  if (!access.ok) {
    const body = await access.response.json().catch(() => ({}));
    return {
      ok: false,
      status: access.response.status,
      code: body.code || "forbidden",
      message: body.message || "Access denied",
    };
  }

  const orgGate = await assertSuperAdminActiveOrgMatches(
    user,
    access.group.orgId ? String(access.group.orgId) : null
  );
  if (!orgGate.ok) {
    return {
      ok: false,
      status: orgGate.status,
      code: orgGate.code,
      message: orgGate.message,
    };
  }

  await connectToDatabase();
  const { group, memberBusinessIds } = access;
  const reviewFilter =
    memberBusinessIds.length > 0
      ? { businessId: { $in: memberBusinessIds } }
      : null;

  const businesses =
    memberBusinessIds.length > 0
      ? await Business.find({ _id: { $in: memberBusinessIds } })
          .select("name active status groupId")
          .sort({ name: 1 })
          .lean()
      : [];

  const emptyMetrics = {
    businessCount: businesses.length,
    totalReviews: 0,
    averageRating: null as number | null,
    unanswered: 0,
    draftsPending: 0,
    publishedReplies: 0,
    locationCount: 0,
  };

  if (!reviewFilter) {
    return {
      ok: true,
      data: {
        group: {
          id: String(group._id),
          name: group.name,
          description: group.description || "",
          active: group.active !== false,
          orgId: String(group.orgId),
        },
        metrics: emptyMetrics,
        ratingDistribution: emptyRatingDistribution(),
        businesses: businesses.map((b) => ({
          businessId: String(b._id),
          name: b.name || "Business",
          status: resolveBusinessLifecycle(b),
          totalReviews: 0,
          unanswered: 0,
          draftsPending: 0,
          publishedReplies: 0,
          averageRating: null,
        })),
        locations: [],
        recentReviews: [],
        reviewsHref: `/orm/reviews?groupId=${encodeURIComponent(String(group._id))}`,
      },
    };
  }

  const perBizAgg = await Review.aggregate<{
    _id: mongoose.Types.ObjectId;
    totalReviews: number;
    unanswered: number;
    draftsPending: number;
    publishedReplies: number;
    ratingSum: number;
    ratingN: number;
  }>([
    {
      $match: {
        businessId: {
          $in: memberBusinessIds.map((id) => new mongoose.Types.ObjectId(id)),
        },
      },
    },
    {
      $group: {
        _id: "$businessId",
        totalReviews: { $sum: 1 },
        unanswered: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$replyComment", ""] },
                  { $eq: ["$replyComment", null] },
                  { $not: ["$replyComment"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        draftsPending: {
          $sum: {
            $cond: [
              {
                $and: [
                  {
                    $in: ["$draftStatus", ["generated", "edited", "approved"]],
                  },
                  {
                    $or: [
                      { $eq: ["$replyComment", ""] },
                      { $eq: ["$replyComment", null] },
                      { $not: ["$replyComment"] },
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
        publishedReplies: {
          $sum: {
            $cond: [
              {
                $and: [
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
  ]);

  const perBizMap = new Map(perBizAgg.map((r) => [String(r._id), r]));

  const [
    totalReviews,
    unanswered,
    draftsPending,
    publishedReplies,
    locationCount,
    averageRating,
    ratingDistribution,
    locDocs,
    recentReviews,
  ] = await Promise.all([
    Review.countDocuments(reviewFilter),
    Review.countDocuments({ ...reviewFilter, ...UNREPLIED }),
    Review.countDocuments({ ...reviewFilter, ...DRAFTS_PENDING }),
    Review.countDocuments({ ...reviewFilter, ...PUBLISHED }),
    Location.countDocuments({ businessId: { $in: memberBusinessIds } }),
    averageRatingForFilter(reviewFilter),
    ratingDistributionForFilter(reviewFilter),
    Location.find({ businessId: { $in: memberBusinessIds } })
      .select("title googleLocationName businessId")
      .lean(),
    recentReviewsForBusinessIds(memberBusinessIds, 10),
  ]);

  const bizName = new Map(
    businesses.map((b) => [String(b._id), b.name || "Business"])
  );

  const comparison: GroupBusinessComparison[] = businesses.map((b) => {
    const bid = String(b._id);
    const row = perBizMap.get(bid);
    return {
      businessId: bid,
      name: b.name || "Business",
      status: resolveBusinessLifecycle(b),
      totalReviews: row?.totalReviews || 0,
      unanswered: row?.unanswered || 0,
      draftsPending: row?.draftsPending || 0,
      publishedReplies: row?.publishedReplies || 0,
      averageRating:
        row && row.ratingN > 0 ? round1(row.ratingSum / row.ratingN) : null,
    };
  });

  return {
    ok: true,
    data: {
      group: {
        id: String(group._id),
        name: group.name,
        description: group.description || "",
        active: group.active !== false,
        orgId: String(group.orgId),
      },
      metrics: {
        businessCount: businesses.length,
        totalReviews,
        averageRating,
        unanswered,
        draftsPending,
        publishedReplies,
        locationCount,
      },
      ratingDistribution,
      businesses: comparison,
      locations: locDocs.map((l) => ({
        locationId: String(l._id),
        title: l.title || l.googleLocationName || "Location",
        businessId: l.businessId ? String(l.businessId) : null,
        businessName: l.businessId
          ? bizName.get(String(l.businessId)) || null
          : null,
      })),
      recentReviews,
      reviewsHref: `/orm/reviews?groupId=${encodeURIComponent(String(group._id))}`,
    },
  };
}

/**
 * Landing choices for /orm — authorized businesses and groups only.
 * SA: scoped to the active organization cookie (never cross-org).
 * BA: explicitly assigned businesses / User.groupIds only (no auto-assign).
 */
export async function getOrmLandingChoices(
  user: AuthUser,
  options: { orgId?: string | null } = {}
): Promise<OrmLandingPayload> {
  await connectToDatabase();
  const orgId =
    options.orgId && mongoose.isValidObjectId(options.orgId)
      ? String(options.orgId)
      : null;

  if (user.role === "superadmin") {
    if (!orgId) {
      return {
        businesses: [],
        groups: [],
        singleBusinessId: null,
        orgId: null,
        needsOrgSelection: true,
      };
    }

    const orgObjectId = new mongoose.Types.ObjectId(orgId);
    const [businessRows, groupDocs] = await Promise.all([
      Business.find({ orgId: orgObjectId })
        .select("name groupId")
        .sort({ name: 1 })
        .lean(),
      BusinessGroup.find({ orgId: orgObjectId })
        .select("name")
        .sort({ name: 1 })
        .lean(),
    ]);

    const counts =
      groupDocs.length > 0
        ? await Business.aggregate<{
            _id: mongoose.Types.ObjectId;
            n: number;
          }>([
            {
              $match: {
                orgId: orgObjectId,
                groupId: { $in: groupDocs.map((g) => g._id) },
              },
            },
            { $group: { _id: "$groupId", n: { $sum: 1 } } },
          ])
        : [];
    const countMap = new Map(counts.map((c) => [String(c._id), c.n]));
    const businesses = serializeBusinessChoices(businessRows);

    return {
      businesses,
      groups: groupDocs.map((g) => ({
        id: String(g._id),
        name: g.name,
        businessCount: countMap.get(String(g._id)) || 0,
      })),
      singleBusinessId: businesses.length === 1 ? businesses[0].id : null,
      orgId,
      needsOrgSelection: false,
    };
  }

  const activeIds = await listActiveBusinessIdsForUser(user);
  const activeObjectIds = toObjectIds(activeIds);

  const businessRows =
    activeObjectIds.length > 0
      ? await Business.find({ _id: { $in: activeObjectIds } })
          .select("name groupId")
          .sort({ name: 1 })
          .lean()
      : [];

  const businesses = serializeBusinessChoices(businessRows);
  let groups: OrmLandingPayload["groups"] = [];

  const gids = toObjectIds(user.groupIds || []);
  if (gids.length > 0) {
    const docs = await BusinessGroup.find({ _id: { $in: gids } })
      .select("name")
      .sort({ name: 1 })
      .lean();
    const counts =
      activeObjectIds.length > 0
        ? await Business.aggregate<{
            _id: mongoose.Types.ObjectId;
            n: number;
          }>([
            {
              $match: {
                groupId: { $in: gids },
                _id: { $in: activeObjectIds },
              },
            },
            { $group: { _id: "$groupId", n: { $sum: 1 } } },
          ])
        : [];
    const countMap = new Map(counts.map((c) => [String(c._id), c.n]));
    groups = docs.map((g) => ({
      id: String(g._id),
      name: g.name,
      businessCount: countMap.get(String(g._id)) || 0,
    }));
  }

  return {
    businesses,
    groups,
    singleBusinessId: businesses.length === 1 ? businesses[0].id : null,
    orgId,
    needsOrgSelection: false,
  };
}

/** Weighted combined average from per-business rating sums — exported for tests. */
export function combinedAverageRating(
  parts: Array<{ ratingSum: number; ratingN: number }>
): number | null {
  let sum = 0;
  let n = 0;
  for (const p of parts) {
    if (p.ratingN > 0) {
      sum += p.ratingSum;
      n += p.ratingN;
    }
  }
  if (n <= 0) return null;
  return round1(sum / n);
}
