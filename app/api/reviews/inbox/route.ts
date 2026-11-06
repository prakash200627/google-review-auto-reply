import { NextResponse } from "next/server";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";
import { listVisibleLocationsForUser } from "@/lib/auth/visibleLocations";
import { resolveReviewsBusinessScope } from "@/lib/auth/reviewsScope";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";
import {
  countReviewInboxMetrics,
  queryReviewInbox,
  type ReviewInboxReplyStatus,
} from "@/lib/reviews/queryInbox";

export const runtime = "nodejs";

const REPLY_STATUSES: ReviewInboxReplyStatus[] = [
  "any",
  "unreplied",
  "replied",
  "draft",
  "approved",
  "drafts",
];

/**
 * Filtered review inbox for Super Admin / Business Admin.
 *
 * SA: scoped to the active organization session (same as ORM dashboards).
 * BA: scoped to assignment-based active businesses.
 * Client-supplied business/group ids never expand authorization.
 */
export async function GET(request: Request) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;

  const url = new URL(request.url);
  const groupId = url.searchParams.get("groupId");
  const businessId = url.searchParams.get("businessId");
  const locationId = url.searchParams.get("locationId");
  const starRaw = url.searchParams.get("starRating");
  const replyRaw = url.searchParams.get("replyStatus") || "any";
  const replyStatus = (
    REPLY_STATUSES.includes(replyRaw as ReviewInboxReplyStatus)
      ? replyRaw
      : "any"
  ) as ReviewInboxReplyStatus;
  const flaggedRaw = url.searchParams.get("flagged");
  const q = url.searchParams.get("q");
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const page = Number(url.searchParams.get("page") || "1");
  const pageSize = Number(url.searchParams.get("pageSize") || "25");
  const includeMetrics = url.searchParams.get("includeMetrics") === "1";

  const scope = await resolveReviewsBusinessScope(auth.user);
  if (!scope.ok) {
    return NextResponse.json(
      {
        success: false,
        code: scope.code,
        message: scope.message,
        reviews: [],
        total: 0,
        page: 1,
        pageSize,
        filters: { groups: [], businesses: [], locations: [] },
      },
      { status: scope.status }
    );
  }

  const allowed = scope.businessIds;
  if (allowed.length === 0) {
    return NextResponse.json({
      success: true,
      orgId: scope.orgId,
      reviews: [],
      total: 0,
      page: 1,
      pageSize,
      metrics: includeMetrics
        ? { total: 0, unreplied: 0, draftsPending: 0, published: 0 }
        : undefined,
      filters: { groups: [], businesses: [], locations: [] },
    });
  }

  let starRating: number | null = null;
  if (starRaw) {
    const n = Number(starRaw);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return NextResponse.json(
        { success: false, message: "starRating must be 1–5." },
        { status: 400 }
      );
    }
    starRating = n;
  }

  // Cross-org URL manipulation: business/group outside allowed set → empty scope.
  const [result, metrics] = await Promise.all([
    queryReviewInbox({
      businessIds: allowed,
      groupId,
      businessId,
      locationId,
      starRating,
      replyStatus,
      flagged:
        flaggedRaw === "true" ? true : flaggedRaw === "false" ? false : null,
      q,
      from: fromRaw ? new Date(fromRaw) : null,
      to: toRaw ? new Date(toRaw) : null,
      page,
      pageSize,
    }),
    includeMetrics
      ? countReviewInboxMetrics({
          businessIds: allowed,
          businessId,
          groupId,
        })
      : Promise.resolve(null),
  ]);

  await connectToDatabase();
  const businesses = await Business.find({ _id: { $in: allowed } })
    .select("_id name groupId replyMode")
    .sort({ name: 1 })
    .lean();
  const groupIds = [
    ...new Set(
      businesses
        .map((b) => (b.groupId ? String(b.groupId) : null))
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const groups =
    groupIds.length > 0
      ? await BusinessGroup.find({ _id: { $in: groupIds } })
          .select("_id name")
          .sort({ name: 1 })
          .lean()
      : [];

  let locations: Array<{ id: string; title: string; businessId: string | null }> =
    [];
  if (scope.orgId) {
    try {
      const visible = await listVisibleLocationsForUser({
        user: auth.user,
        orgId: scope.orgId,
        businessId: businessId || null,
      });
      locations = visible.map((loc) => ({
        id: loc.id,
        title: loc.title || loc.googleLocationName || "Location",
        businessId: businessId || null,
      }));
    } catch {
      locations = [];
    }
  }

  return NextResponse.json({
    success: true,
    orgId: scope.orgId,
    ...result,
    metrics: metrics || undefined,
    filters: {
      groups: groups.map((g) => ({ id: String(g._id), name: g.name })),
      businesses: businesses.map((b) => ({
        id: String(b._id),
        name: b.name,
        groupId: b.groupId ? String(b.groupId) : null,
        replyMode: b.replyMode || "manual",
      })),
      locations,
    },
  });
}
