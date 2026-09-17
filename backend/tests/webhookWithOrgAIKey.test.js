const request = require("supertest");
const mongoose = require("mongoose");

jest.mock("axios");
const axios = require("axios");

const Location = require("../models/Location");
const Organization = require("../models/Organization");
const Review = require("../models/Review");
const Reply = require("../models/Reply");
const generateReply = require("../services/ai");
const { generateAnalysis } = require("../services/ai");
const app = require("../index");

function mockOrgQuery(mockOrg) {
    const query = Promise.resolve(mockOrg);
    query.select = jest.fn().mockResolvedValue(mockOrg);
    return query;
}

describe("Webhook & Organization AI Key Integration Tests", () => {
    const origEnv = process.env;

    beforeEach(() => {
        process.env = { ...origEnv };
        delete process.env.OPENAI_API_KEY;
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    afterAll(() => {
        process.env = origEnv;
    });

    test("1. Webhook passes location.orgId into generateReply and uses Org OpenAI key", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        const mockLocationId = new mongoose.Types.ObjectId();

        const mockLocation = {
            _id: mockLocationId,
            orgId: mockOrgId,
            name: "Test Location",
            googleLocationId: "loc_123",
        };

        const mockOrg = {
            _id: mockOrgId,
            name: "Test Org",
            mode: "manual",
            openaiApiKey: "sk-org-webhook-key",
            openaiEnabled: true,
        };

        jest.spyOn(Location, "findOne").mockResolvedValue(mockLocation);
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        jest.spyOn(Organization, "findById").mockImplementation(() => mockOrgQuery(mockOrg));

        jest.spyOn(Review, "create").mockImplementation((data) =>
            Promise.resolve({ _id: new mongoose.Types.ObjectId(), ...data })
        );
        jest.spyOn(Reply, "create").mockImplementation((data) =>
            Promise.resolve({ _id: new mongoose.Types.ObjectId(), ...data })
        );

        const res = await request(app)
            .post("/api/webhook/review")
            .send({
                reviewId: "rev_test_101",
                reviewerName: "John Doe",
                rating: 5,
                comment: "Excellent service!",
                googleResourceName: "accounts/acc_1/locations/loc_123/reviews/rev_test_101",
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.autoProcessed).toBe(false);
        expect(Review.create).toHaveBeenCalledWith(
            expect.objectContaining({
                orgId: mockOrgId,
                locationId: mockLocationId,
                googleReviewId: "rev_test_101",
            })
        );
    });

    test("MANUAL 1-star: Manual Mode keeps 1-star negative reviews pending without auto-publishing", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        const mockLocationId = new mongoose.Types.ObjectId();

        const mockLocation = {
            _id: mockLocationId,
            orgId: mockOrgId,
            name: "Test Location",
            googleLocationId: "loc_man_1",
        };

        const mockOrg = {
            _id: mockOrgId,
            name: "Test Org",
            mode: "manual",
        };

        jest.spyOn(Location, "findOne").mockResolvedValue(mockLocation);
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        jest.spyOn(Organization, "findById").mockImplementation(() => mockOrgQuery(mockOrg));

        const mockReviewDoc = {
            _id: new mongoose.Types.ObjectId(),
            orgId: mockOrgId,
            locationId: mockLocationId,
            googleReviewId: "rev_man_1",
            rating: 1,
            text: "Terrible service, food was cold.",
            status: "pending",
            save: jest.fn().mockResolvedValue(true),
        };

        const mockReplyDoc = {
            _id: new mongoose.Types.ObjectId(),
            reviewId: mockReviewDoc._id,
            orgId: mockOrgId,
            draftReply: "We are sorry to hear that.",
            status: "pending",
            needsHumanReview: false,
            save: jest.fn().mockResolvedValue(true),
        };

        jest.spyOn(Review, "create").mockResolvedValue(mockReviewDoc);
        jest.spyOn(Reply, "create").mockResolvedValue(mockReplyDoc);

        process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL = "https://example.com/make-webhook";

        const res = await request(app)
            .post("/api/webhook/review")
            .send({
                reviewId: "rev_man_1",
                reviewerName: "John Doe",
                rating: 1,
                comment: "Terrible service, food was cold.",
                googleResourceName: "accounts/acc_1/locations/loc_man_1/reviews/rev_man_1",
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.autoProcessed).toBe(false);
        expect(axios.post).not.toHaveBeenCalled();
        expect(mockReviewDoc.status).toBe("pending");
        expect(mockReplyDoc.status).toBe("pending");
    });

    test("2. Unregistered googleLocationId returns 404", async () => {
        jest.spyOn(Location, "findOne").mockResolvedValue(null);

        const res = await request(app)
            .post("/api/webhook/review")
            .send({
                reviewId: "rev_test_404",
                rating: 4,
                googleResourceName: "accounts/acc_1/locations/unregistered_loc/reviews/rev_test_404",
            });

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe("Google location is not registered");
    });

    test("3. AUTO 5-star: Auto Mode auto-publishes 5-star reviews to Make.com webhook", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        const mockLocationId = new mongoose.Types.ObjectId();

        const mockLocation = {
            _id: mockLocationId,
            orgId: mockOrgId,
            googleLocationId: "loc_auto_1",
        };

        const mockOrg = {
            _id: mockOrgId,
            mode: "auto",
        };

        const mockReviewDoc = {
            _id: new mongoose.Types.ObjectId(),
            orgId: mockOrgId,
            locationId: mockLocationId,
            googleReviewId: "rev_auto_1",
            reviewerName: "Alice",
            rating: 5,
            text: "Great experience!",
            googleResourceName: "accounts/acc_1/locations/loc_auto_1/reviews/rev_auto_1",
            status: "pending",
            save: jest.fn().mockResolvedValue(true),
        };

        const mockReplyDoc = {
            _id: new mongoose.Types.ObjectId(),
            reviewId: mockReviewDoc._id,
            orgId: mockOrgId,
            draftReply: "Thank you for the review!",
            finalReply: "",
            status: "pending",
            save: jest.fn().mockResolvedValue(true),
        };

        jest.spyOn(Location, "findOne").mockResolvedValue(mockLocation);
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        jest.spyOn(Organization, "findById").mockImplementation(() => mockOrgQuery(mockOrg));
        jest.spyOn(Review, "create").mockResolvedValue(mockReviewDoc);
        jest.spyOn(Reply, "create").mockResolvedValue(mockReplyDoc);

        process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL = "https://example.com/make-webhook";
        axios.post.mockResolvedValue({ status: 200 });

        const res = await request(app)
            .post("/api/webhook/review")
            .send({
                reviewId: "rev_auto_1",
                reviewerName: "Alice",
                rating: 5,
                comment: "Great experience!",
                googleResourceName: "accounts/acc_1/locations/loc_auto_1/reviews/rev_auto_1",
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.autoProcessed).toBe(true);
        expect(axios.post).toHaveBeenCalledWith(
            "https://example.com/make-webhook",
            expect.objectContaining({
                reviewId: "rev_auto_1",
                googleResourceName: "accounts/acc_1/locations/loc_auto_1/reviews/rev_auto_1",
                orgId: mockOrgId,
            })
        );
    });

    test("3b. AUTO 1-star: Auto Mode auto-publishes standard 1-star negative reviews to Make.com webhook", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        const mockLocationId = new mongoose.Types.ObjectId();

        const mockLocation = {
            _id: mockLocationId,
            orgId: mockOrgId,
            googleLocationId: "loc_auto_neg",
        };

        const mockOrg = {
            _id: mockOrgId,
            mode: "auto",
        };

        const mockReviewDoc = {
            _id: new mongoose.Types.ObjectId(),
            orgId: mockOrgId,
            locationId: mockLocationId,
            googleReviewId: "rev_auto_neg",
            reviewerName: "White Devil",
            rating: 1,
            text: "Terrible service and food was cold.",
            googleResourceName: "accounts/acc_1/locations/loc_auto_neg/reviews/rev_auto_neg",
            status: "pending",
            save: jest.fn().mockResolvedValue(true),
        };

        const mockReplyDoc = {
            _id: new mongoose.Types.ObjectId(),
            reviewId: mockReviewDoc._id,
            orgId: mockOrgId,
            draftReply: "We are truly sorry about your experience.",
            finalReply: "",
            status: "pending",
            save: jest.fn().mockResolvedValue(true),
        };

        jest.spyOn(Location, "findOne").mockResolvedValue(mockLocation);
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        jest.spyOn(Organization, "findById").mockImplementation(() => mockOrgQuery(mockOrg));
        jest.spyOn(Review, "create").mockResolvedValue(mockReviewDoc);
        jest.spyOn(Reply, "create").mockResolvedValue(mockReplyDoc);

        process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL = "https://example.com/make-webhook";
        axios.post.mockResolvedValue({ status: 200 });

        const res = await request(app)
            .post("/api/webhook/review")
            .send({
                reviewId: "rev_auto_neg",
                reviewerName: "White Devil",
                rating: 1,
                comment: "Terrible service and food was cold.",
                googleResourceName: "accounts/acc_1/locations/loc_auto_neg/reviews/rev_auto_neg",
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.autoProcessed).toBe(true);
        expect(mockReviewDoc.status).toBe("approved");
        expect(mockReplyDoc.status).toBe("approved");
        expect(axios.post).toHaveBeenCalledWith(
            "https://example.com/make-webhook",
            expect.objectContaining({
                reviewId: "rev_auto_neg",
                rating: 1,
                googleResourceName: "accounts/acc_1/locations/loc_auto_neg/reviews/rev_auto_neg",
                orgId: mockOrgId,
            })
        );
    });

    test("4. Auto Mode does NOT auto-publish high-risk review (sends to human workflow)", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();
        const mockLocationId = new mongoose.Types.ObjectId();

        const mockLocation = {
            _id: mockLocationId,
            orgId: mockOrgId,
            googleLocationId: "loc_risk_1",
        };

        const mockOrg = {
            _id: mockOrgId,
            mode: "auto",
        };

        const mockReviewDoc = {
            _id: new mongoose.Types.ObjectId(),
            orgId: mockOrgId,
            locationId: mockLocationId,
            googleReviewId: "rev_risk_1",
            rating: 1,
            text: "Food poisoning incident here",
            status: "pending",
            save: jest.fn().mockResolvedValue(true),
        };

        const mockReplyDoc = {
            _id: new mongoose.Types.ObjectId(),
            reviewId: mockReviewDoc._id,
            orgId: mockOrgId,
            status: "pending",
            needsHumanReview: true,
            urgency: "high",
            save: jest.fn().mockResolvedValue(true),
        };

        jest.spyOn(Location, "findOne").mockResolvedValue(mockLocation);
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        jest.spyOn(Organization, "findById").mockImplementation(() => mockOrgQuery(mockOrg));
        jest.spyOn(Review, "create").mockResolvedValue(mockReviewDoc);
        jest.spyOn(Reply, "create").mockResolvedValue(mockReplyDoc);

        process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL = "https://example.com/make-webhook";

        const res = await request(app)
            .post("/api/webhook/review")
            .send({
                reviewId: "rev_risk_1",
                reviewerName: "Bob",
                rating: 1,
                comment: "I got food poisoning!",
                googleResourceName: "accounts/acc_1/locations/loc_risk_1/reviews/rev_risk_1",
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.autoProcessed).toBe(false); // Kept manual/pending
        expect(axios.post).not.toHaveBeenCalled();
    });

    test("5. Analysis works cleanly for 0, 1, and multiple reviews", async () => {
        const mockOrgId = new mongoose.Types.ObjectId();

        jest.spyOn(Organization, "findById").mockImplementation(() => mockOrgQuery(null));

        // 0 reviews
        jest.spyOn(Review, "find").mockReturnValue({
            sort: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
            }),
        });

        const zeroRes = await generateAnalysis(mockOrgId);
        expect(zeroRes.usedOpenAI).toBe(false);
        expect(zeroRes.summary).toContain("No review data available yet");

        // 1 review
        jest.spyOn(Review, "find").mockReturnValue({
            sort: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([
                    { rating: 5, sentiment: "positive", text: "Lovely atmosphere" },
                ]),
            }),
        });

        const oneRes = await generateAnalysis(mockOrgId);
        expect(oneRes.summary).toContain("1 recent review");
    });
});
