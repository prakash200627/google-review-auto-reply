const generateReply = require("../services/ai");

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

    test("Does not crash if OPENAI_API_KEY is an invalid key string", async () => {
        process.env.OPENAI_API_KEY = "sk-invalid-key-test";
        const result = await generateReply({ rating: 4, comment: "Nice ambience" });
        expect(result.draftReply).toBeDefined();
        // Even if OpenAI fails, fallback reply should be returned safely
        expect(result.draftReply.length).toBeGreaterThan(10);
    });
});
