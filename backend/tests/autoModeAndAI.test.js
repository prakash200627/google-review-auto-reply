const generateReply = require("../services/ai");
const { buildReplyMessages, extractFirstName } = require("../services/ai");

jest.mock("openai", () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: jest.fn().mockRejectedValue(
                    Object.assign(new Error("Incorrect API key provided"), { status: 401 })
                ),
            },
        },
    })),
}));

describe("AI Reply Service & Safety Tests", () => {
    const origEnv = process.env;

    beforeEach(() => {
        process.env = { ...origEnv };
        delete process.env.OPENAI_API_KEY;
    });

    afterAll(() => {
        process.env = origEnv;
    });

    test("Generates fallback positive reply when OPENAI_API_KEY is missing", async () => {
        const result = await generateReply({ rating: 5, comment: "Great food and service!" });
        expect(result.sentiment).toBe("positive");
        expect(result.draftReply).toContain("Thank you so much");
        expect(result.needsHumanReview).toBe(false);
        expect(result.urgency).toBe("low");
        expect(result.usedOpenAI).toBe(false);
    });

    test("Handles textual star rating 'FIVE' properly", async () => {
        const result = await generateReply({ rating: "FIVE", comment: "Awesome experience" });
        expect(result.sentiment).toBe("positive");
        expect(result.draftReply).toBeDefined();
    });

    test("Flags high-risk safety keywords for human review", async () => {
        const result = await generateReply({
            rating: 1,
            comment: "I suffered food poisoning after eating here! Calling my lawyer.",
        });
        expect(result.sentiment).toBe("negative");
        expect(result.needsHumanReview).toBe(true);
        expect(result.urgency).toBe("high");
    });

    test("Does NOT flag standard 1-star negative review for human review without safety keywords", async () => {
        const result = await generateReply({
            rating: 1,
            comment: "The food was cold and service was very slow.",
        });
        expect(result.sentiment).toBe("negative");
        expect(result.needsHumanReview).toBe(false);
        expect(result.urgency).toBe("medium");
        expect(result.draftReply).toBeDefined();
    });

    test("Does not crash if OPENAI_API_KEY is an invalid key string", async () => {
        process.env.OPENAI_API_KEY = "sk-invalid-key-test";
        const result = await generateReply({ rating: 4, comment: "Nice ambience" });
        expect(result.draftReply).toBeDefined();
        // Even if OpenAI fails, fallback reply should be returned safely
        expect(result.draftReply.length).toBeGreaterThan(10);
    });

    // ── Reviewer name personalization tests ─────────────────────────────────

    test("Extracts first name 'White' from reviewerName 'White Devil' and reply is generated", async () => {
        // No OpenAI key – uses fallback. Extraction logic in ai.js must not crash.
        const result = await generateReply({
            rating: 5,
            comment: "Amazing food and great service. Really enjoyed the atmosphere!",
            reviewerName: "White Devil",
        });
        expect(result.draftReply).toBeDefined();
        expect(result.draftReply.length).toBeGreaterThan(10);
        expect(result.usedOpenAI).toBe(false); // no key configured in this test
    });

    test("OpenAI prompt contains firstName 'White' and the review text when reviewerName is 'White Devil'", () => {
        const messages = buildReplyMessages({
            rating: 5,
            comment: "Amazing biryani and friendly staff.",
            firstName: extractFirstName("White Devil"),
        });
        const allContent = messages.map((m) => m.content).join("\n");

        expect(allContent).toContain("first name, White");
        expect(allContent).toContain("Reviewer first name: White");
        expect(allContent).toContain("Amazing biryani and friendly staff.");
        expect(allContent).toContain("Star rating: 5/5");
    });

    test("generateReply works without reviewerName (no name in prompt)", async () => {
        const result = await generateReply({
            rating: 5,
            comment: "Great experience overall.",
            // No reviewerName supplied
        });
        expect(result.draftReply).toBeDefined();
        expect(result.draftReply.length).toBeGreaterThan(10);
    });

    test("First name extracted correctly from multi-word reviewer names", () => {
        const cases = [
            ["White Devil",              "White"],
            ["Videsh Thota",             "Videsh"],
            ["Kajuluri Bhavani Prakash", "Kajuluri"],
            ["Alice",                    "Alice"],
            ["",                         ""],
        ];
        for (const [fullName, expected] of cases) {
            expect(extractFirstName(fullName)).toBe(expected);
        }
    });

    test("Generic or invalid reviewer names are not used for personalization", () => {
        expect(extractFirstName("A Google User")).toBe("");
        expect(extractFirstName("Anonymous")).toBe("");
        expect(extractFirstName("12345")).toBe("");
        expect(extractFirstName(undefined)).toBe("");
        expect(extractFirstName("PRIYA SHARMA")).toBe("Priya");
    });
});
