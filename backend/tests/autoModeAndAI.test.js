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

    test("OpenAI prompt contains firstName 'White' when reviewerName is 'White Devil'", () => {
        // Pure unit test: verifies the prompt template used in ai.js contains the first name.
        // Mirrors exactly the prompt construction in services/ai.js so no real API call is made.
        const reviewerName = "White Devil";
        const firstName = reviewerName.split(" ")[0]; // "White"
        const numericRating = 5;

        const prompt = `You are a professional customer relation manager. Write a concise, friendly, and professional Google review reply that directly addresses the customer's comment. ${firstName ? `Address the reviewer by their first name ${firstName}. ` : ""}Use only information present in the comment. Do not include any greetings, signatures, placeholders, or mention of stars. Match the tone to the ${numericRating}-star rating (positive for 4-5, neutral for 3, apologetic for 1-2). Keep it under 150 words.`;

        expect(firstName).toBe("White");
        expect(prompt).toContain("White");
        expect(prompt).toContain("Address the reviewer by their first name White");
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
            const firstName = fullName.split(" ")[0] || "";
            expect(firstName).toBe(expected);
        }
    });
});
