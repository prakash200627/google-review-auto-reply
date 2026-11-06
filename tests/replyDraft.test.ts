import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDraftUserPrompt,
  classifyReviewTone,
  generateReplyDraft,
  ReplyDraftError,
} from "@/lib/ai/replyDraft";
import { resetDraftRateLimitForTests } from "@/lib/ai/rateLimit";

describe("classifyReviewTone", () => {
  it("maps ratings to positive, neutral, and negative", () => {
    expect(classifyReviewTone(5)).toBe("positive");
    expect(classifyReviewTone(4)).toBe("positive");
    expect(classifyReviewTone(3)).toBe("neutral");
    expect(classifyReviewTone(2)).toBe("negative");
    expect(classifyReviewTone(1)).toBe("negative");
    expect(classifyReviewTone(null)).toBe("neutral");
  });
});

describe("buildDraftUserPrompt", () => {
  it("includes comment for positive reviews", () => {
    const prompt = buildDraftUserPrompt({
      starRating: 5,
      comment: "Amazing service and friendly staff",
      reviewerDisplayName: "Alex",
    });
    expect(prompt).toMatch(/Tone guidance: positive/);
    expect(prompt).toMatch(/Amazing service and friendly staff/);
    expect(prompt).toMatch(/Alex/);
  });

  it("handles empty comments without inventing visit details", () => {
    const prompt = buildDraftUserPrompt({
      starRating: 2,
      comment: "",
    });
    expect(prompt).toMatch(/Tone guidance: negative/);
    expect(prompt).toMatch(/\(none — rating only\)/);
    expect(prompt).not.toMatch(/refund|manager called|yesterday/i);
  });

  it("marks 3-star reviews as neutral", () => {
    const prompt = buildDraftUserPrompt({
      starRating: 3,
      comment: "It was okay",
    });
    expect(prompt).toMatch(/Tone guidance: neutral/);
  });
});

describe("generateReplyDraft", () => {
  const env = {
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-4o-mini",
  };

  beforeEach(() => {
    resetDraftRateLimitForTests();
  });

  it("returns a positive draft from OpenAI", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                "Thank you for the kind words about our service, Alex! We are glad you had a great visit.",
            },
          },
        ],
      }),
    });

    const result = await generateReplyDraft(
      {
        starRating: 5,
        comment: "Amazing service",
        reviewerDisplayName: "Alex",
      },
      fetchImpl,
      env
    );

    expect(result.tone).toBe("positive");
    expect(result.draft).toMatch(/Thank you/);
    expect(result.model).toBe("gpt-4o-mini");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key"
    );
  });

  it("returns a negative draft tone for low ratings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                "We are sorry your experience fell short. Please contact us directly so we can make this right.",
            },
          },
        ],
      }),
    });

    const result = await generateReplyDraft(
      { starRating: 1, comment: "Terrible wait times" },
      fetchImpl,
      env
    );
    expect(result.tone).toBe("negative");
    expect(result.draft).toMatch(/sorry/i);
  });

  it("returns a neutral draft for mid ratings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                "Thank you for sharing your feedback. We appreciate your notes and continue to improve.",
            },
          },
        ],
      }),
    });

    const result = await generateReplyDraft(
      { starRating: 3, comment: "Average experience" },
      fetchImpl,
      env
    );
    expect(result.tone).toBe("neutral");
  });

  it("generates for empty-comment reviews using rating only", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: "Thank you for the 5-star rating. We appreciate your support.",
            },
          },
        ],
      }),
    });

    const result = await generateReplyDraft(
      { starRating: 5, comment: "   " },
      fetchImpl,
      env
    );
    expect(result.tone).toBe("positive");
    expect(result.draft.length).toBeGreaterThan(0);

    const body = JSON.parse(
      String((fetchImpl.mock.calls[0][1] as RequestInit).body)
    ) as { messages: Array<{ content: string }> };
    expect(body.messages[1].content).toMatch(/\(none — rating only\)/);
  });

  it("maps OpenAI failures to ReplyDraftError without leaking secrets", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: { message: "Internal server error", type: "server_error" },
      }),
    });

    await expect(
      generateReplyDraft({ starRating: 4, comment: "Good" }, fetchImpl, env)
    ).rejects.toBeInstanceOf(ReplyDraftError);

    await expect(
      generateReplyDraft({ starRating: 4, comment: "Good" }, fetchImpl, env)
    ).rejects.toMatchObject({ code: "openai_error" });
  });

  it("maps 429 to rate_limited", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "Rate limit" } }),
    });

    await expect(
      generateReplyDraft({ starRating: 5, comment: "Nice" }, fetchImpl, env)
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("fails clearly when OpenAI is not configured", async () => {
    await expect(
      generateReplyDraft(
        { starRating: 5, comment: "Nice" },
        vi.fn(),
        { OPENAI_API_KEY: "" }
      )
    ).rejects.toMatchObject({ code: "not_configured", status: 503 });
  });
});
