import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { toReviewSummary } from "@/lib/google/syncReviews";

describe("toReviewSummary draft hydration fields", () => {
  it("includes persisted draft text and approval", () => {
    const id = new mongoose.Types.ObjectId();
    const summary = toReviewSummary({
      _id: id,
      reviewerDisplayName: "Alex",
      starRating: 5,
      comment: "Great",
      replyComment: "",
      draftText: "Thanks for visiting!",
      draftApproved: true,
      draftStatus: "approved",
    });

    expect(summary.id).toBe(String(id));
    expect(summary.draftText).toBe("Thanks for visiting!");
    expect(summary.draftApproved).toBe(true);
    expect(summary.draftStatus).toBe("approved");
  });

  it("defaults missing draft fields safely", () => {
    const summary = toReviewSummary({
      _id: new mongoose.Types.ObjectId(),
    });
    expect(summary.draftText).toBe("");
    expect(summary.draftApproved).toBe(false);
    expect(summary.draftStatus).toBe("");
  });
});
