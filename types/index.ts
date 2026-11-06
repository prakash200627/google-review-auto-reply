/**
 * Shared domain types for the Review Auto-Reply application.
 */

export type OrganizationMode = "manual" | "auto";

export interface OrganizationSummary {
  id: string;
  name: string;
  email: string;
  mode: OrganizationMode;
}

/**
 * Dashboard metrics from stored Mongo documents only (never fabricated).
 *
 * Definitions:
 * - connectedLocations: Location docs in scope (assigned to the business when
 *   businessId is set; otherwise org/owner scope as documented in getDashboardStats).
 * - reviewCount: Review docs in scope.
 * - pendingReviews / unanswered: reviews with empty/missing replyComment
 *   (computed as reviewCount − publishedReplies).
 * - publishedReplies: TRONX-confirmed publications only (replySource=tronx_published
 *   or tronxPublishedAt set). Google-synced replies are counted separately.
 * - googleSyncedReplies: replies observed on Google during sync (not TRONX publish).
 * - averageRating: arithmetic mean of numeric starRating values in scope;
 *   reviews without a numeric rating are excluded; null when none qualify.
 * - locationTitle: title (or googleLocationName) of the assigned location when
 *   exactly one is in scope; null otherwise.
 * - googleConnectionStatus: active → connected; error → error; none → missing.
 * - draftsAwaitingApproval: reviews with draftStatus approved/generated awaiting
 *   publish, plus AutoPublishJob awaiting_approval when businessId set.
 * - failedReplies: reviews with a non-empty lastPublishError in scope.
 */
export interface DashboardStats {
  connectedLocations: number;
  pendingReviews: number;
  publishedReplies: number;
  googleSyncedReplies: number;
  reviewCount: number;
  averageRating: number | null;
  locationTitle: string | null;
  googleConnectionStatus: "connected" | "error" | "missing";
  draftsAwaitingApproval: number;
  failedReplies: number;
}

export interface ReviewListItem {
  id: string;
  reviewerDisplayName: string;
  starRating: number | null;
  comment: string;
  createTime: string | null;
  updateTime: string | null;
}
