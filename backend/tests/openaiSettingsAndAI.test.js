const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const generateReply = require("../services/ai");
const { generateAnalysis } = require("../services/ai");
const Organization = require("../models/Organization");
const Review = require("../models/Review");
const app = require("../index");

jest.mock("openai", () => {
    return {
        OpenAI: jest.fn().mockImplementation((config) => {
            if (config.apiKey === "sk-failing-key") {
                return {
                    chat: {
                        completions: {
                            create: jest.fn().mockRejectedValue(new Error("API rate limit exceeded")),
                        },
                    },
                };
            }
            return {
                chat: {
                    completions: {
                        create: jest.fn().mockResolvedValue({
                            choices: [
                                {
                                    message: {
                                        content: `OpenAI reply generated using key ${config.apiKey}`,
                                    },
                                },
                            ],
                        }),
                    },
                },
            };
        }),
    };
});

function generateToken(orgId) {
    const payload = { organizationId: orgId };
    const secret = process.env.JWT_SECRET || "testsecret";
    return jwt.sign(payload, secret, { expiresIn: "1h" });
}

describe("OpenAI Settings & AI Logic Tests", () => {
    const origEnv = process.env;

    beforeEach(() => {
        process.env = { ...origEnv };
        delete process.env.OPENAI_API_KEY;
        jest.restoreAllMocks();
    });

    afterAll(() => {
        process.env = origEnv;
    });

    test("1. No API key -> fallback works", async () => {
        const result = await generateReply({ rating: 5, comment: "Great service!" });
        expect(result.usedOpenAI).toBe(false);
        expect(result.draftReply).toContain("Thank you so much");
    });

    test("2. Environment API key -> OpenAI works", async () => {
        process.env.OPENAI_API_KEY = "sk-env-test-key";
        const result = await generateReply({ rating: 5, comment: "Great service!" });
        expect(result.usedOpenAI).toBe(true);
        expect(result.draftReply).toContain("sk-env-test-key");
    });

    test("3. Organization API key -> OpenAI works", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        jest.spyOn(Organization, "findById").mockReturnValue({
            select: jest.fn().mockResolvedValue({
                _id: mockOrgId,
                openaiApiKey: "sk-org-test-key",
                openaiEnabled: true,
            }),
        });

        const result = await generateReply({ rating: 5, comment: "Awesome!" }, mockOrgId);
        expect(result.usedOpenAI).toBe(true);
        expect(result.draftReply).toContain("sk-org-test-key");
    });

    test("4. Organization key overrides environment key", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key";
        const mockOrgId = new mongoose.Types.ObjectId();
        jest.spyOn(Organization, "findById").mockReturnValue({
            select: jest.fn().mockResolvedValue({
                _id: mockOrgId,
                openaiApiKey: "sk-org-precedence-key",
                openaiEnabled: true,
            }),
        });

        const result = await generateReply({ rating: 5, comment: "Superb!" }, mockOrgId);
        expect(result.usedOpenAI).toBe(true);
        expect(result.draftReply).toContain("sk-org-precedence-key");
    });

    test("5. OpenAI disabled -> fallback works", async () => {
        process.env.OPENAI_API_KEY = "sk-env-key";
        const mockOrgId = new mongoose.Types.ObjectId();
        jest.spyOn(Organization, "findById").mockReturnValue({
            select: jest.fn().mockResolvedValue({
                _id: mockOrgId,
                openaiApiKey: "sk-org-key",
                openaiEnabled: false,
            }),
        });

        const result = await generateReply({ rating: 5, comment: "Good food" }, mockOrgId);
        expect(result.usedOpenAI).toBe(false);
        expect(result.draftReply).toContain("Thank you so much");
    });

    test("6. OpenAI failure -> fallback works safely", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        jest.spyOn(Organization, "findById").mockReturnValue({
            select: jest.fn().mockResolvedValue({
                _id: mockOrgId,
                openaiApiKey: "sk-failing-key",
                openaiEnabled: true,
            }),
        });

        const result = await generateReply({ rating: 4, comment: "Nice place" }, mockOrgId);
        expect(result.usedOpenAI).toBe(false);
        expect(result.draftReply).toContain("Thank you so much");
    });

    test("7 & 8. API key save works & status works", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        const token = generateToken(mockOrgId);

        const mockOrg = {
            _id: mockOrgId,
            openaiApiKey: null,
            openaiEnabled: true,
            save: jest.fn().mockResolvedValue(true),
        };

        jest.spyOn(Organization, "findById").mockReturnValue({
            select: jest.fn().mockResolvedValue(mockOrg),
        });

        // POST /api/organization/openai-key (Save key)
        const postRes = await request(app)
            .post("/api/organization/openai-key")
            .set("Authorization", `Bearer ${token}`)
            .send({ apiKey: "sk-saved-key-123" });

        expect(postRes.status).toBe(200);
        expect(postRes.body.success).toBe(true);
        expect(postRes.body.configured).toBe(true);
        expect(postRes.body.enabled).toBe(true);
        expect(postRes.body.apiKey).toBeUndefined(); // Key not returned

        // Test saving empty key returns 400 validation error
        const emptyRes = await request(app)
            .post("/api/organization/openai-key")
            .set("Authorization", `Bearer ${token}`)
            .send({ apiKey: "   " });
        expect(emptyRes.status).toBe(400);
        expect(emptyRes.body.success).toBe(false);
    });

    test("9. API key is never returned by GET endpoint", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        const token = generateToken(mockOrgId);

        jest.spyOn(Organization, "findById").mockReturnValue({
            select: jest.fn().mockResolvedValue({
                _id: mockOrgId,
                openaiApiKey: "sk-super-secret-key",
                openaiEnabled: true,
            }),
        });

        const getRes = await request(app)
            .get("/api/organization/openai-key")
            .set("Authorization", `Bearer ${token}`);

        expect(getRes.status).toBe(200);
        expect(getRes.body.configured).toBe(true);
        expect(getRes.body.enabled).toBe(true);
        expect(getRes.body.openaiApiKey).toBeUndefined();
        expect(getRes.body.apiKey).toBeUndefined();
        expect(JSON.stringify(getRes.body)).not.toContain("sk-super-secret-key");
    });

    test("14. AI Analysis endpoint works with fallback and OpenAI key", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        const token = generateToken(mockOrgId);

        jest.spyOn(Organization, "findById").mockReturnValue({
            select: jest.fn().mockResolvedValue({
                _id: mockOrgId,
                openaiApiKey: "sk-org-analysis-key",
                openaiEnabled: true,
            }),
        });

        jest.spyOn(Review, "find").mockReturnValue({
            sort: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([
                    { rating: 5, sentiment: "positive", text: "Great food and ambience!" },
                ]),
            }),
        });

        const analysisRes = await request(app)
            .get("/api/stats/analysis")
            .set("Authorization", `Bearer ${token}`);

        expect(analysisRes.status).toBe(200);
        expect(analysisRes.body.success).toBe(true);
        expect(analysisRes.body.analysis).toBeDefined();
    });
});
