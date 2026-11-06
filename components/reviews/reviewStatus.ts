import type { ReviewInboxItem } from "@/lib/reviews/queryInbox";

export type ReviewsTab = "inbox" | "drafts" | "published";

export type ReviewLifecycleState =
  | "needs_reply"
  | "draft_generated"
  | "draft_edited"
  | "draft_approved"
  | "published"
  | "unknown";

export const REVIEWS_TABS: Array<{ id: ReviewsTab; label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "drafts", label: "Drafts" },
  { id: "published", label: "Published" },
];

export function tabToReplyStatus(
  tab: ReviewsTab
): "unreplied" | "drafts" | "replied" {
  if (tab === "drafts") return "drafts";
  if (tab === "published") return "replied";
  return "unreplied";
}

export function parseReviewsTab(value: string | null | undefined): ReviewsTab {
  if (value === "drafts" || value === "published" || value === "inbox") {
    return value;
  }
  return "inbox";
}

/**
 * Classify persisted review state. Published (non-empty replyComment) wins over
 * draft flags — an approved draft is never treated as published.
 */
export function classifyReviewLifecycle(
  review: Pick<
    ReviewInboxItem,
    "replyComment" | "draftStatus" | "draftApproved" | "draftText"
  >
): ReviewLifecycleState {
  if (review.replyComment?.trim()) return "published";
  if (review.draftApproved || review.draftStatus === "approved") {
    return "draft_approved";
  }
  if (review.draftStatus === "edited") return "draft_edited";
  if (review.draftStatus === "generated") return "draft_generated";
  if (review.draftText?.trim()) return "draft_generated";
  if (
    !review.replyComment?.trim() &&
    (!review.draftStatus ||
      review.draftStatus === "none" ||
      review.draftStatus === "")
  ) {
    return "needs_reply";
  }
  return "unknown";
}

export function replyStatusLabel(review: ReviewInboxItem): string {
  switch (classifyReviewLifecycle(review)) {
    case "published":
      return "Published";
    case "draft_approved":
      return "Approved draft";
    case "draft_edited":
      return "Edited draft";
    case "draft_generated":
      return "Draft";
    case "needs_reply":
      return "Needs reply";
    default:
      return "Needs reply";
  }
}

export function emptyMessageForTab(tab: ReviewsTab): string {
  if (tab === "drafts") return "No reply drafts yet.";
  if (tab === "published") return "No published replies yet.";
  return "No reviews need attention.";
}

export function emptyStateDetail(input: {
  tab: ReviewsTab;
  hasActiveFilters: boolean;
  locationCount: number;
  metricsTotal: number | null;
}): { title: string; detail: string } {
  if (input.hasActiveFilters) {
    return {
      title: "No matching reviews",
      detail: "Try clearing filters or adjusting your search.",
    };
  }
  if (input.metricsTotal === 0 && input.locationCount === 0) {
    return {
      title: emptyMessageForTab(input.tab),
      detail:
        "No Google locations are visible yet. Discover locations and fetch reviews under GMB → Locations (explicit actions only).",
    };
  }
  if (input.metricsTotal === 0) {
    return {
      title: emptyMessageForTab(input.tab),
      detail:
        "No reviews are stored for this scope yet. Open a location under GMB and use Fetch reviews — nothing syncs automatically.",
    };
  }
  return {
    title: emptyMessageForTab(input.tab),
    detail:
      input.tab === "inbox"
        ? "Stored reviews in this scope already have replies or are filed under Drafts."
        : "Nothing in this section for the current business scope.",
  };
}

export function formatReviewDate(iso: string | null): string {
  if (!iso) return "Unknown date";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "Unknown date";
  }
}

/** Tabs a lifecycle state belongs to for UI expectations / tests. */
export function tabsForLifecycle(
  state: ReviewLifecycleState
): ReviewsTab[] {
  if (state === "published") return ["published"];
  if (
    state === "draft_generated" ||
    state === "draft_edited" ||
    state === "draft_approved"
  ) {
    return ["drafts"];
  }
  if (state === "needs_reply") return ["inbox"];
  return [];
}
