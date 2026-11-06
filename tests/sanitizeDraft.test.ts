import { describe, expect, it } from "vitest";
import {
  containsForbiddenDemoMarker,
  sanitizeReplyDraft,
} from "@/lib/ai/sanitizeDraft";
import { buildDraftSystemPrompt } from "@/lib/ai/replyDraft";
import {
  prepareReplyForPublish,
  PublishReplyError,
} from "@/lib/google/publishReply";

describe("sanitizeReplyDraft", () => {
  it("removes trailing DEMO / TEST markers without changing real copy", () => {
    expect(sanitizeReplyDraft("Thanks for visiting! — DEMO")).toBe(
      "Thanks for visiting!"
    );
    expect(sanitizeReplyDraft("We appreciate your feedback [DEMO]")).toBe(
      "We appreciate your feedback"
    );
    expect(sanitizeReplyDraft("Sorry about that (DEMO)")).toBe(
      "Sorry about that"
    );
    expect(sanitizeReplyDraft("Thank you DEMO")).toBe("Thank you");
    expect(sanitizeReplyDraft("Thank you #DEMO")).toBe("Thank you");
    expect(sanitizeReplyDraft("Great review — TEST REPLY")).toBe("Great review");
    expect(sanitizeReplyDraft("All set (TEST)")).toBe("All set");
    expect(sanitizeReplyDraft("All set TEST")).toBe("All set");
  });

  it("removes SAMPLE and WATERMARK suffixes mentioned in the system prompt", () => {
    expect(sanitizeReplyDraft("Thanks for coming — SAMPLE")).toBe(
      "Thanks for coming"
    );
    expect(sanitizeReplyDraft("Appreciate it [SAMPLE]")).toBe("Appreciate it");
    expect(sanitizeReplyDraft("See you soon WATERMARK")).toBe("See you soon");
    expect(sanitizeReplyDraft("See you soon — WATERMARK")).toBe("See you soon");
  });

  it("clears stacked trailing markers", () => {
    expect(sanitizeReplyDraft("Thanks! — DEMO — TEST")).toBe("Thanks!");
    expect(sanitizeReplyDraft("Thanks!\n\nDEMO\nTEST")).toBe("Thanks!");
  });

  it("handles punctuation and whitespace around markers", () => {
    expect(sanitizeReplyDraft("  Thanks!   — DEMO  ")).toBe("Thanks!");
    expect(sanitizeReplyDraft("Thanks.\n\nDEMO")).toBe("Thanks.");
    expect(sanitizeReplyDraft("Thanks —")).toBe("Thanks");
  });

  it("does not strip the word demo from mid-sentence business wording", () => {
    expect(
      sanitizeReplyDraft("Thanks for trying our demo tasting menu!")
    ).toBe("Thanks for trying our demo tasting menu!");
    expect(
      sanitizeReplyDraft("We loved hosting your product demo yesterday.")
    ).toBe("We loved hosting your product demo yesterday.");
    expect(sanitizeReplyDraft("We do not protest unfair reviews.")).toBe(
      "We do not protest unfair reviews."
    );
  });

  it("detects forbidden markers used for regression guards", () => {
    expect(containsForbiddenDemoMarker("Hello — DEMO")).toBe(true);
    expect(containsForbiddenDemoMarker("Hello — SAMPLE")).toBe(true);
    expect(containsForbiddenDemoMarker("Hello there")).toBe(false);
  });

  it("system prompt forbids demo/test suffixes", () => {
    const prompt = buildDraftSystemPrompt().toLowerCase();
    expect(prompt).toMatch(/never append demo/);
    expect(prompt).toMatch(/test/);
    expect(prompt).toMatch(/sample|watermark/);
  });

  it("prepareReplyForPublish sanitizes then validates approved text", () => {
    expect(prepareReplyForPublish("  Thank you for visiting! — DEMO ")).toBe(
      "Thank you for visiting!"
    );
    expect(prepareReplyForPublish("Thank you — SAMPLE")).toBe("Thank you");
  });

  it("prepareReplyForPublish rejects empty or marker-only replies", () => {
    expect(() => prepareReplyForPublish("")).toThrow(PublishReplyError);
    expect(() => prepareReplyForPublish("   ")).toThrow(PublishReplyError);
    expect(() => prepareReplyForPublish("DEMO")).toThrow(PublishReplyError);
    expect(() => prepareReplyForPublish("— DEMO")).toThrow(PublishReplyError);
    expect(() => prepareReplyForPublish("SAMPLE")).toThrow(PublishReplyError);
    expect(() => prepareReplyForPublish("WATERMARK")).toThrow(PublishReplyError);
  });
});
