import { describe, expect, it } from "vitest";
import {
  classifyReviewLifecycle,
  replyStatusLabel,
  tabsForLifecycle,
} from "@/components/reviews/reviewStatus";
import type { ReviewInboxItem } from "@/lib/reviews/queryInbox";

function base(
  patch: Partial<ReviewInboxItem> = {}
): ReviewInboxItem {
  return {
    id: "r1",
    businessId: "b1",
    locationId: "l1",
    locationTitle: "Store",
    reviewerDisplayName: "Pat",
    starRating: 4,
    comment: "Nice",
    createTime: null,
    updateTime: null,
    replyComment: "",
    replyUpdateTime: null,
    replySource: "",
    draftText: "",
    draftStatus: "none",
    draftApproved: false,
    draftUpdatedAt: null,
    flagged: false,
    ...patch,
  };
}

describe("review lifecycle classification", () => {
  it("maps unanswered reviews to inbox", () => {
    const state = classifyReviewLifecycle(base());
    expect(state).toBe("needs_reply");
    expect(tabsForLifecycle(state)).toEqual(["inbox"]);
    expect(replyStatusLabel(base())).toBe("Needs reply");
  });

  it("maps generated and edited drafts to Drafts, not Published", () => {
    expect(
      classifyReviewLifecycle(
        base({ draftStatus: "generated", draftText: "Thanks" })
      )
    ).toBe("draft_generated");
    expect(
      classifyReviewLifecycle(
        base({ draftStatus: "edited", draftText: "Thanks!" })
      )
    ).toBe("draft_edited");
    expect(
      tabsForLifecycle("draft_edited")
    ).toEqual(["drafts"]);
    expect(
      replyStatusLabel(base({ draftStatus: "edited", draftText: "x" }))
    ).toBe("Edited draft");
  });

  it("keeps approved drafts distinct from published replies", () => {
    const approved = base({
      draftStatus: "approved",
      draftApproved: true,
      draftText: "Approved text",
      replyComment: "",
    });
    expect(classifyReviewLifecycle(approved)).toBe("draft_approved");
    expect(replyStatusLabel(approved)).toBe("Approved draft");
    expect(tabsForLifecycle("draft_approved")).toEqual(["drafts"]);
  });

  it("classifies non-empty replyComment as published only", () => {
    const published = base({
      replyComment: "Public reply",
      replySource: "tronx_published",
      draftStatus: "approved",
      draftApproved: true,
    });
    expect(classifyReviewLifecycle(published)).toBe("published");
    expect(replyStatusLabel(published)).toBe("Published");
    expect(tabsForLifecycle("published")).toEqual(["published"]);
  });

  it("does not treat google_synced empty drafts as needing publish success", () => {
    const synced = base({
      replyComment: "Existing Google reply",
      replySource: "google_synced",
      draftText: "",
      draftStatus: "none",
    });
    expect(classifyReviewLifecycle(synced)).toBe("published");
  });
});
