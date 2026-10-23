const request = require("supertest");

jest.mock("axios");
jest.mock("openai", () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: jest.fn().mockRejectedValue(new Error("no openai")) } },
    })),
}));

const app = require("../index");

describe("Retired Make.com webhook endpoints", () => {
    test("POST /api/webhook/review returns 410 and does not process reviews", async () => {
        const res = await request(app)
            .post("/api/webhook/review")
            .send({
                reviewId: "rev_1",
                rating: "FIVE",
                googleResourceName: "accounts/a/locations/l/reviews/rev_1",
                comment: "should not be stored",
            });
        expect(res.status).toBe(410);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/removed/i);
    });

    test("POST /api/webhook/publish-result returns 410", async () => {
        const res = await request(app)
            .post("/api/webhook/publish-result")
            .send({ status: "published", publishAttemptId: "x".repeat(32) });
        expect(res.status).toBe(410);
        expect(res.body.success).toBe(false);
    });

    test("other /api/webhook paths return 410", async () => {
        const res = await request(app).get("/api/webhook/anything");
        expect(res.status).toBe(410);
    });
});
