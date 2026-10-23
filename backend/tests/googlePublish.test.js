const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

jest.mock("axios");
jest.mock("openai", () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: jest.fn() } },
    })),
}));

jest.mock("../services/googleBusinessApi", () => {
    const actual = jest.requireActual("../services/googleBusinessApi");
    return {
        ...actual,
        updateReviewReply: jest.fn(),
        getReview: jest.fn(),
    };
});

jest.mock("../services/googleOAuth", () => {
    const actual = jest.requireActual("../services/googleOAuth");
    return {
        ...actual,
        getValidAccessToken: jest.fn().mockResolvedValue("access-token"),
        loadActiveConnectionForOrg: jest.fn(),
        isOAuthConfigured: jest.fn(() => true),
    };
});

const { updateReviewReply, getReview, GoogleApiError } = require("../services/googleBusinessApi");
const { loadActiveConnectionForOrg } = require("../services/googleOAuth");
const Location = require("../models/Location");
const Review = require("../models/Review");
const Reply = require("../models/Reply");
const app = require("../index");

function tokenFor(orgId) {
    return jwt.sign({ organizationId: orgId }, "testsecret", { expiresIn: "1h" });
}

function reviewDoc(fields) {
    const doc = {
        _id: new mongoose.Types.ObjectId(),
        status: "pending",
        rating: 5,
        text: "",
        reviewerName: "",
        googleReviewId: "rev_1",
        googleResourceName: "accounts/acc/locations/loc/reviews/rev_1",
        locationId: new mongoose.Types.ObjectId(),
        save: jest.fn().mockResolvedValue(true),
        ...fields,
    };
    return doc;
}

describe("Direct Google publish", () => {
    const orgId = new mongoose.Types.ObjectId();
    const connectionId = new mongoose.Types.ObjectId();
    const locationId = new mongoose.Types.ObjectId();
    let review;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});

        review = reviewDoc({ orgId, locationId });
        jest.spyOn(Review, "findById").mockResolvedValue(review);
        jest.spyOn(Location, "findOne").mockResolvedValue({
            _id: locationId,
            orgId,
            connectionId,
            googleLocationId: "loc",
            googleAccountId: "acc",
        });
        loadActiveConnectionForOrg.mockResolvedValue({
            _id: connectionId,
            orgId,
            status: "active",
            encryptedAccessToken: "enc",
            encryptedRefreshToken: "enc",
            accessTokenExpiresAt: new Date(Date.now() + 3600000),
        });
    });

    function arrangePendingReply() {
        const replyId = new mongoose.Types.ObjectId();
        let stored = {
            _id: replyId,
            orgId,
            reviewId: review._id,
            status: "pending",
            draftReply: "Thanks for visiting!",
            publishState: "none",
        };
        jest.spyOn(Reply, "findOne").mockResolvedValue({ ...stored });
        jest.spyOn(Reply, "findOneAndUpdate").mockImplementation((filter, update) => {
            stored = { ...stored, ...update.$set };
            return Promise.resolve({ ...stored });
        });
        jest.spyOn(Reply, "findById").mockImplementation(() => Promise.resolve({ ...stored }));
        return replyId;
    }

    test("successful Google updateReply marks reply published", async () => {
        arrangePendingReply();
        updateReviewReply.mockResolvedValue({ comment: "Thanks for visiting!" });

        const res = await request(app)
            .post("/api/reply/approve")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: review._id.toString(), finalReply: "Thanks for visiting!" });

        expect(res.status).toBe(200);
        expect(res.body.publishState).toBe("published");
        expect(res.body.reply.status).toBe("published");
        expect(updateReviewReply).toHaveBeenCalledWith(
            "access-token",
            review.googleResourceName,
            "Thanks for visiting!"
        );
        expect(review.status).toBe("published");
    });

    test("definitive Google API error returns reply to pending", async () => {
        arrangePendingReply();
        updateReviewReply.mockRejectedValue(
            new GoogleApiError("permission denied", { status: 403, code: "forbidden" })
        );

        const res = await request(app)
            .post("/api/reply/approve")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: review._id.toString() });

        expect(res.status).toBe(502);
        expect(res.body.publishState).toBe("failed");
        expect(res.body.reply.status).toBe("pending");
        expect(review.status).toBe("pending");
    });

    test("timeout marks publishState unknown without reverting approval", async () => {
        arrangePendingReply();
        updateReviewReply.mockRejectedValue(
            new GoogleApiError("timed out", { status: 504, code: "timeout" })
        );

        const res = await request(app)
            .post("/api/reply/approve")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: review._id.toString() });

        expect(res.status).toBe(202);
        expect(res.body.publishState).toBe("unknown");
        expect(res.body.reply.status).toBe("approved");
        expect(review.status).toBe("approved");
    });

    test("missing Google connection blocks approve without claiming the reply", async () => {
        arrangePendingReply();
        loadActiveConnectionForOrg.mockResolvedValue(null);
        const claim = Reply.findOneAndUpdate;

        const res = await request(app)
            .post("/api/reply/approve")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: review._id.toString() });

        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/Google/i);
        expect(claim).not.toHaveBeenCalled();
        expect(updateReviewReply).not.toHaveBeenCalled();
    });

    test("retry-publish only works from unknown state", async () => {
        const replyId = new mongoose.Types.ObjectId();
        jest.spyOn(Reply, "findOne").mockResolvedValue({
            _id: replyId,
            orgId,
            status: "approved",
            publishState: "accepted",
            draftReply: "Hi",
            finalReply: "Hi",
        });

        const res = await request(app)
            .post("/api/reply/retry-publish")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: review._id.toString() });

        expect(res.status).toBe(409);
        expect(updateReviewReply).not.toHaveBeenCalled();
    });

    test("reconcile can confirm published from Google getReview", async () => {
        const replyId = new mongoose.Types.ObjectId();
        const startedAt = new Date(Date.now() - 60 * 60 * 1000);
        jest.spyOn(Reply, "findOne").mockResolvedValue({
            _id: replyId,
            orgId,
            status: "approved",
            publishState: "sending",
            publishRequestedAt: startedAt,
            draftReply: "Thanks!",
            finalReply: "Thanks!",
        });
        getReview.mockResolvedValue({ reviewReply: { comment: "Thanks!" } });
        jest.spyOn(Reply, "findOneAndUpdate").mockResolvedValue({
            _id: replyId,
            status: "published",
            publishState: "published",
        });
        jest.spyOn(Review, "updateOne").mockResolvedValue({ acknowledged: true });

        const res = await request(app)
            .post("/api/reply/reconcile-publish")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: review._id.toString() });

        expect(res.status).toBe(200);
        expect(res.body.publishState).toBe("published");
    });
});
