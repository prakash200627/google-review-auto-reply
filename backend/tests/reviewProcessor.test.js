const mongoose = require("mongoose");

jest.mock("openai", () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: jest.fn().mockRejectedValue(new Error("no key")) } },
    })),
}));

jest.mock("../services/publisher", () => {
    const actual = jest.requireActual("../services/publisher");
    return {
        ...actual,
        canPublishReview: jest.fn(),
        dispatchPublish: jest.fn(),
    };
});

const Review = require("../models/Review");
const Reply = require("../models/Reply");
const Organization = require("../models/Organization");
const { processIncomingReview } = require("../services/reviewProcessor");
const { canPublishReview, dispatchPublish } = require("../services/publisher");

describe("processIncomingReview", () => {
    const orgId = new mongoose.Types.ObjectId();
    const location = {
        _id: new mongoose.Types.ObjectId(),
        orgId,
        googleLocationId: "loc_1",
        googleAccountId: "acc_1",
    };

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        canPublishReview.mockResolvedValue({ ok: false, message: "Google OAuth is not configured on the server" });
        dispatchPublish.mockResolvedValue({ outcome: "published", reply: {} });
    });

    test("creates review + pending reply in manual mode", async () => {
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        jest.spyOn(Review, "create").mockImplementation(async (data) => ({
            _id: new mongoose.Types.ObjectId(),
            ...data,
            save: jest.fn(),
        }));
        jest.spyOn(Reply, "create").mockImplementation(async (data) => ({
            _id: new mongoose.Types.ObjectId(),
            ...data,
            save: jest.fn(),
        }));
        jest.spyOn(Organization, "findById").mockResolvedValue({ _id: orgId, mode: "manual" });

        const result = await processIncomingReview({
            location,
            googleReviewId: "rev_new",
            reviewerName: "Alex",
            rating: 5,
            comment: "Great place",
            googleResourceName: "accounts/acc_1/locations/loc_1/reviews/rev_new",
        });

        expect(result.created).toBe(true);
        expect(result.autoProcessed).toBe(false);
        expect(result.reply.status).toBe("pending");
        expect(dispatchPublish).not.toHaveBeenCalled();
    });

    test("duplicate review does not regenerate AI when reply exists", async () => {
        const existing = {
            _id: new mongoose.Types.ObjectId(),
            orgId,
            googleReviewId: "rev_dup",
            reviewerName: "Alex",
            googleResourceName: "accounts/acc_1/locations/loc_1/reviews/rev_dup",
            save: jest.fn(),
        };
        jest.spyOn(Review, "findOne").mockResolvedValue(existing);
        jest.spyOn(Reply, "findOne").mockResolvedValue({ _id: new mongoose.Types.ObjectId(), status: "pending" });
        const createReview = jest.spyOn(Review, "create");

        const result = await processIncomingReview({
            location,
            googleReviewId: "rev_dup",
            reviewerName: "Alex",
            rating: 5,
            comment: "Great place",
            googleResourceName: "accounts/acc_1/locations/loc_1/reviews/rev_dup",
        });

        expect(result.created).toBe(false);
        expect(createReview).not.toHaveBeenCalled();
        expect(dispatchPublish).not.toHaveBeenCalled();
    });

    test("rejects cross-organization duplicate review IDs", async () => {
        jest.spyOn(Review, "findOne").mockResolvedValue({
            _id: new mongoose.Types.ObjectId(),
            orgId: new mongoose.Types.ObjectId(),
            googleReviewId: "shared",
        });

        await expect(
            processIncomingReview({
                location,
                googleReviewId: "shared",
                rating: 4,
                comment: "ok",
                googleResourceName: "accounts/acc_1/locations/loc_1/reviews/shared",
            })
        ).rejects.toMatchObject({ status: 409 });
    });

    test("auto mode publishes non-flagged reviews including 1-star when Google is configured", async () => {
        canPublishReview.mockResolvedValue({ ok: true });
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        const review = {
            _id: new mongoose.Types.ObjectId(),
            orgId,
            status: "pending",
            save: jest.fn().mockResolvedValue(true),
        };
        jest.spyOn(Review, "create").mockResolvedValue(review);
        const reply = {
            _id: new mongoose.Types.ObjectId(),
            status: "pending",
            draftReply: "Sorry to hear that",
            save: jest.fn().mockResolvedValue(true),
        };
        jest.spyOn(Reply, "create").mockResolvedValue(reply);
        jest.spyOn(Organization, "findById").mockResolvedValue({ _id: orgId, mode: "auto" });
        dispatchPublish.mockResolvedValue({ outcome: "published", reply: { ...reply, status: "published" } });

        const result = await processIncomingReview({
            location,
            googleReviewId: "rev_neg",
            reviewerName: "Sam",
            rating: 1,
            comment: "The food was cold and service was slow.",
            googleResourceName: "accounts/acc_1/locations/loc_1/reviews/rev_neg",
        });

        expect(result.created).toBe(true);
        expect(result.autoProcessed).toBe(true);
        expect(dispatchPublish).toHaveBeenCalled();
        expect(reply.status).toBe("approved");
    });

    test("auto mode does not publish flagged high-risk reviews", async () => {
        canPublishReview.mockResolvedValue({ ok: true });
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        jest.spyOn(Review, "create").mockResolvedValue({
            _id: new mongoose.Types.ObjectId(),
            orgId,
            status: "pending",
            save: jest.fn(),
        });
        jest.spyOn(Reply, "create").mockImplementation(async (data) => ({
            _id: new mongoose.Types.ObjectId(),
            ...data,
            save: jest.fn(),
        }));
        jest.spyOn(Organization, "findById").mockResolvedValue({ _id: orgId, mode: "auto" });

        const result = await processIncomingReview({
            location,
            googleReviewId: "rev_risk",
            rating: 1,
            comment: "I got food poisoning and will call my lawyer",
            googleResourceName: "accounts/acc_1/locations/loc_1/reviews/rev_risk",
        });

        expect(result.autoProcessed).toBe(false);
        expect(result.reply.needsHumanReview).toBe(true);
        expect(dispatchPublish).not.toHaveBeenCalled();
    });

    test("auto mode without Google connection leaves reply pending with error", async () => {
        canPublishReview.mockResolvedValue({
            ok: false,
            message: "Location is not linked to a Google connection",
        });
        jest.spyOn(Review, "findOne").mockResolvedValue(null);
        jest.spyOn(Review, "create").mockResolvedValue({
            _id: new mongoose.Types.ObjectId(),
            orgId,
            status: "pending",
            save: jest.fn(),
        });
        const reply = {
            _id: new mongoose.Types.ObjectId(),
            status: "pending",
            save: jest.fn().mockResolvedValue(true),
        };
        jest.spyOn(Reply, "create").mockResolvedValue(reply);
        jest.spyOn(Organization, "findById").mockResolvedValue({ _id: orgId, mode: "auto" });

        const result = await processIncomingReview({
            location,
            googleReviewId: "rev_auto",
            rating: 5,
            comment: "Loved it",
            googleResourceName: "accounts/acc_1/locations/loc_1/reviews/rev_auto",
        });

        expect(result.autoProcessed).toBe(false);
        expect(reply.lastPublishError).toMatch(/Google connection/i);
        expect(dispatchPublish).not.toHaveBeenCalled();
    });
});
