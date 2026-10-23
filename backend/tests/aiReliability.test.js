const mongoose = require("mongoose");

const mockCreate = jest.fn();
jest.mock("openai", () => ({
    OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
}));
const { OpenAI } = require("openai");

const generateReply = require("../services/ai");
const { generateAnalysis, clearAnalysisCache, validateReplyOutput, computeReviewMetrics } = require("../services/ai");
const Organization = require("../models/Organization");
const Review = require("../models/Review");

function completion(content, finishReason = "stop") {
    return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

function mockOrg(org) {
    jest.spyOn(Organization, "findById").mockReturnValue({
        select: jest.fn().mockResolvedValue(org),
    });
}

function mockRecentReviews(reviews) {
    jest.spyOn(Review, "find").mockReturnValue({
        sort: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(reviews),
        }),
    });
}

function sentMessages() {
    return mockCreate.mock.calls[0][0].messages.map((m) => m.content).join("\n");
}

describe("generateReply reliability", () => {
    const orgId = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.restoreAllMocks();
        mockCreate.mockReset();
        OpenAI.mockClear();
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_MODEL;
    });

    test("sends the review text, rating and first name to gpt-4o-mini with a bounded timeout", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockCreate.mockResolvedValue(completion("Hi Priya, thank you for the lovely words about our dosa!"));

        const result = await generateReply({ rating: 5, comment: "The masala dosa was superb", reviewerName: "Priya Sharma" });

        expect(result.usedOpenAI).toBe(true);
        expect(result.draftReply).toBe("Hi Priya, thank you for the lovely words about our dosa!");
        const request = mockCreate.mock.calls[0][0];
        expect(request.model).toBe("gpt-4o-mini");
        expect(sentMessages()).toContain("The masala dosa was superb");
        expect(sentMessages()).toContain("Star rating: 5/5");
        expect(sentMessages()).toContain("Reviewer first name: Priya");
        expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ timeout: expect.any(Number), maxRetries: 1 }));
    });

    test("uses the organization's brand voice and language", async () => {
        mockOrg({ _id: orgId, openaiApiKey: "sk-org-key-12345678", openaiEnabled: true, brandVoice: "premium", language: "Hindi" });
        mockCreate.mockResolvedValue(completion("Thank you for visiting us and sharing your thoughts."));

        await generateReply({ rating: 4, comment: "Nice" }, orgId);

        expect(sentMessages()).toContain("Write in Hindi");
        expect(sentMessages()).toContain("refined and gracious");
    });

    test("OPENAI_MODEL overrides the default model server-side", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        process.env.OPENAI_MODEL = "gpt-4o-mini-2024-07-18";
        mockCreate.mockResolvedValue(completion("Thank you for the kind review, we appreciate it."));

        await generateReply({ rating: 5, comment: "Great" });

        expect(mockCreate.mock.calls[0][0].model).toBe("gpt-4o-mini-2024-07-18");
    });

    test("no API key anywhere -> fallback without calling OpenAI", async () => {
        mockOrg({ _id: orgId, openaiApiKey: null, openaiEnabled: true });
        const result = await generateReply({ rating: 2, comment: "Slow service" }, orgId);
        expect(result.usedOpenAI).toBe(false);
        expect(OpenAI).not.toHaveBeenCalled();
        expect(result.draftReply.length).toBeGreaterThan(20);
    });

    test("AI disabled for the org ignores both org and env keys", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockOrg({ _id: orgId, openaiApiKey: "sk-org-key-12345678", openaiEnabled: false });
        const result = await generateReply({ rating: 5, comment: "Great" }, orgId);
        expect(result.usedOpenAI).toBe(false);
        expect(OpenAI).not.toHaveBeenCalled();
    });

    test("fallback reply is personalised with the reviewer's first name", async () => {
        const result = await generateReply({ rating: 5, comment: "Great", reviewerName: "Arjun K" });
        expect(result.draftReply).toContain("Arjun");
    });

    function namedError(name, message, props = {}) {
        const Ctor = { [name]: class extends Error {} }[name];
        return Object.assign(new Ctor(message), props);
    }

    test.each([
        ["timeout", namedError("APIConnectionTimeoutError", "Request timed out.")],
        ["rate limit", Object.assign(new Error("Rate limit reached"), { status: 429 })],
        ["quota", Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" })],
        ["invalid key", Object.assign(new Error("Incorrect API key provided: sk-org-secret-123456"), { status: 401 })],
        ["server error", Object.assign(new Error("Internal error"), { status: 500 })],
    ])("%s -> safe fallback, and the API key is never logged", async (_label, error) => {
        mockOrg({ _id: orgId, openaiApiKey: "sk-org-secret-123456", openaiEnabled: true });
        mockCreate.mockRejectedValue(error);
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        const result = await generateReply({ rating: 4, comment: "Nice place" }, orgId);

        expect(result.usedOpenAI).toBe(false);
        expect(result.draftReply).toContain("Thank you so much");
        const logged = errorSpy.mock.calls.flat().join(" ");
        expect(logged).not.toContain("sk-org-secret-123456");
    });

    test.each([
        ["empty content", completion("")],
        ["null content", completion(null)],
        ["no choices", { choices: [] }],
        ["placeholder", completion("Thank you [Customer Name] for visiting [Business Name]!")],
        ["truncated", completion("Thank you so much for your wonderful review of our", "length")],
        ["too long", completion("Thanks! ".repeat(200))],
    ])("malformed model output (%s) falls back to a safe reply", async (_label, response) => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockCreate.mockResolvedValue(response);
        jest.spyOn(console, "warn").mockImplementation(() => {});

        const result = await generateReply({ rating: 5, comment: "Great food" });

        expect(result.usedOpenAI).toBe(false);
        expect(result.draftReply).toContain("Thank you so much");
        expect(result.needsHumanReview).toBe(false);
    });

    test("AI reply promising a refund is discarded and routed to human review", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockCreate.mockResolvedValue(completion("We're so sorry. We will issue a full refund and a free dessert next time."));
        jest.spyOn(console, "warn").mockImplementation(() => {});

        const result = await generateReply({ rating: 2, comment: "Order was wrong and cold" });

        expect(result.usedOpenAI).toBe(false);
        expect(result.draftReply).not.toMatch(/refund/i);
        expect(result.needsHumanReview).toBe(true);
        expect(result.riskReasons).toContain("ai_unconfirmed_commitment");
    });

    test("high-risk escalation is independent of successful AI generation", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockCreate.mockResolvedValue(completion("Thank you for letting us know. Please contact us directly so we can talk."));

        const result = await generateReply({ rating: 5, comment: "Food was great but my kid had an allergic reaction" });

        expect(result.usedOpenAI).toBe(true);
        expect(result.needsHumanReview).toBe(true);
        expect(result.urgency).toBe("high");
        expect(result.riskReasons).toContain("allergy_medical");
    });

    test.each([
        [5, "positive", "low"],
        [4, "positive", "low"],
        [3, "neutral", "low"],
        [2, "negative", "medium"],
        [1, "negative", "medium"],
    ])("rating %i -> sentiment %s, urgency %s for ordinary reviews", async (rating, sentiment, urgency) => {
        const result = await generateReply({ rating, comment: "It was okay" });
        expect(result.sentiment).toBe(sentiment);
        expect(result.urgency).toBe(urgency);
        expect(result.needsHumanReview).toBe(false);
    });

    test("validateReplyOutput strips wrapping quotes and labels", () => {
        expect(validateReplyOutput('Reply: "Thank you for the kind words, Sam!"').text)
            .toBe("Thank you for the kind words, Sam!");
    });
});

describe("generateAnalysis reliability", () => {
    const orgId = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.restoreAllMocks();
        mockCreate.mockReset();
        OpenAI.mockClear();
        clearAnalysisCache();
        delete process.env.OPENAI_API_KEY;
    });

    const sample = [
        { _id: "a", rating: 5, sentiment: "neutral", text: "Loved the food", createdAt: new Date("2026-01-03") },
        { _id: "b", rating: 4, sentiment: "positive", text: "Good service", createdAt: new Date("2026-01-02") },
        { _id: "c", rating: 1, sentiment: "negative", text: "Very slow", createdAt: new Date("2026-01-01") },
    ];

    test("metrics are computed from ratings without double counting", () => {
        const m = computeReviewMetrics(sample);
        expect(m).toMatchObject({ total: 3, positive: 2, neutral: 0, negative: 1, averageRating: 3.3, positivePct: 67 });
    });

    test("empty dataset returns an honest message and never calls OpenAI", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockOrg(null);
        mockRecentReviews([]);

        const result = await generateAnalysis(orgId);

        expect(result.usedOpenAI).toBe(false);
        expect(result.reviewsAnalyzed).toBe(0);
        expect(result.summary).toContain("No review data available yet");
        expect(OpenAI).not.toHaveBeenCalled();
    });

    test("fallback summary only states computed facts", async () => {
        mockOrg(null);
        mockRecentReviews(sample);

        const result = await generateAnalysis(orgId);

        expect(result.usedOpenAI).toBe(false);
        expect(result.summary).toContain("3 recent reviews");
        expect(result.summary).toContain("average rating 3.3/5");
        expect(result.summary).toContain("2 positive, 0 neutral, 1 negative");
        expect(result.summary).toContain("small sample");
        expect(result.summary).not.toMatch(/remains strong/i);
    });

    test("OpenAI receives computed metrics and the result is cached for unchanged data", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockOrg(null);
        mockRecentReviews(sample);
        mockCreate.mockResolvedValue(completion("Customers praise the food and service, while one review mentions slow service."));

        const first = await generateAnalysis(orgId);
        const second = await generateAnalysis(orgId);

        expect(first.usedOpenAI).toBe(true);
        expect(second).toEqual(first);
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(sentMessages()).toContain("average rating 3.3/5");
        expect(sentMessages()).toContain("[1/5] Very slow");
    });

    test("new reviews invalidate the cached analysis", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockOrg(null);
        mockCreate.mockResolvedValue(completion("Customers praise the food and service overall in these reviews."));

        mockRecentReviews(sample);
        await generateAnalysis(orgId);
        mockRecentReviews([{ _id: "d", rating: 2, text: "Cold", createdAt: new Date("2026-01-04") }, ...sample]);
        await generateAnalysis(orgId);

        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    test.each([
        ["failure", () => mockCreate.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }))],
        ["malformed output", () => mockCreate.mockResolvedValue(completion(""))],
        ["truncated output", () => mockCreate.mockResolvedValue(completion("Customers generally like the food but", "length"))],
    ])("AI %s falls back to the computed summary", async (_label, arrange) => {
        process.env.OPENAI_API_KEY = "sk-env-key-abcdefgh";
        mockOrg(null);
        mockRecentReviews(sample);
        arrange();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});

        const result = await generateAnalysis(orgId);

        expect(result.usedOpenAI).toBe(false);
        expect(result.summary).toContain("3 recent reviews");
    });
});
