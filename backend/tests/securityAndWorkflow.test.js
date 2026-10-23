const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

jest.mock("axios");

jest.mock("openai", () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: jest.fn().mockRejectedValue(new Error("should not be called")) } },
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

const { updateReviewReply, GoogleApiError } = require("../services/googleBusinessApi");
const { loadActiveConnectionForOrg, isOAuthConfigured } = require("../services/googleOAuth");
const Location = require("../models/Location");
const Organization = require("../models/Organization");
const Review = require("../models/Review");
const Reply = require("../models/Reply");
const authRoutes = require("../routes/auth");
const app = require("../index");

function tokenFor(orgId, secret = "testsecret", options = {}) {
    return jwt.sign({ organizationId: orgId }, secret, { expiresIn: "1h", ...options });
}

function queryResult(result) {
    const query = {
        populate: jest.fn(() => query),
        sort: jest.fn(() => query),
        skip: jest.fn(() => query),
        limit: jest.fn(() => query),
        select: jest.fn(() => Promise.resolve(result)),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return query;
}

function reviewDoc(fields) {
    const doc = {
        _id: new mongoose.Types.ObjectId(),
        status: "pending",
        rating: 5,
        text: "",
        reviewerName: "",
        save: jest.fn().mockResolvedValue(true),
        ...fields,
    };
    doc.toObject = () => ({ ...doc, save: undefined, toObject: undefined });
    return doc;
}

const silence = () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
};

function mockPublishReady(orgId, locationId) {
    const connectionId = new mongoose.Types.ObjectId();
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
        accessTokenExpiresAt: new Date(Date.now() + 3600000),
    });
    isOAuthConfigured.mockReturnValue(true);
}

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    isOAuthConfigured.mockReturnValue(true);
    loadActiveConnectionForOrg.mockResolvedValue(null);
    updateReviewReply.mockReset();
    authRoutes.loginLimiter.reset();
    authRoutes.registerLimiter.reset();
    silence();
});

describe("Authentication", () => {
    test.each([
        ["get", "/api/reviews"],
        ["get", "/api/reviews/pending"],
        ["get", "/api/stats"],
        ["get", "/api/stats/analysis"],
        ["get", "/api/organization/me"],
        ["get", "/api/organization/openai-key"],
        ["post", "/api/reply/approve"],
        ["post", "/api/reply/reject"],
        ["get", "/api/locations"],
        ["get", "/api/google/status"],
    ])("%s %s requires a token", async (method, path) => {
        const res = await request(app)[method](path);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    test("token signed with a different secret is rejected", async () => {
        const res = await request(app)
            .get("/api/reviews")
            .set("Authorization", `Bearer ${tokenFor(new mongoose.Types.ObjectId(), "attacker-secret")}`);
        expect(res.status).toBe(401);
    });

    test("expired token is rejected", async () => {
        const token = jwt.sign(
            { organizationId: new mongoose.Types.ObjectId(), exp: Math.floor(Date.now() / 1000) - 60 },
            "testsecret"
        );
        const res = await request(app).get("/api/reviews").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
    });

    test("unsigned (alg none) token is rejected", async () => {
        const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
        const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({ organizationId: new mongoose.Types.ObjectId().toString() })}.`;
        const res = await request(app).get("/api/reviews").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
    });

    test("token without a valid organization id is rejected", async () => {
        const res = await request(app)
            .get("/api/stats")
            .set("Authorization", `Bearer ${tokenFor("not-an-object-id")}`);
        expect(res.status).toBe(401);
    });

    test("login rejects operator-injection payloads with 400", async () => {
        const findSpy = jest.spyOn(Organization, "findOne");
        const res = await request(app).post("/api/auth/login").send({ email: { $gt: "" }, password: "x" });
        expect(res.status).toBe(400);
        expect(findSpy).not.toHaveBeenCalled();
    });

    test("login without a password returns 400 instead of 500", async () => {
        const res = await request(app).post("/api/auth/login").send({ email: "a@b.com" });
        expect(res.status).toBe(400);
    });

    test("login with wrong credentials returns a generic 401", async () => {
        jest.spyOn(Organization, "findOne").mockResolvedValue(null);
        const res = await request(app).post("/api/auth/login").send({ email: "a@b.com", password: "whatever1" });
        expect(res.status).toBe(401);
        expect(res.body.message).toBe("Invalid email or password");
    });

    test("register rejects weak passwords and invalid emails", async () => {
        const weak = await request(app).post("/api/auth/register").send({ name: "Org", email: "a@b.com", password: "123" });
        expect(weak.status).toBe(400);
        const badEmail = await request(app).post("/api/auth/register").send({ name: "Org", email: "nope", password: "longenough1" });
        expect(badEmail.status).toBe(400);
    });

    test("login is rate limited", async () => {
        jest.spyOn(Organization, "findOne").mockResolvedValue(null);
        let last;
        for (let i = 0; i < 21; i++) {
            last = await request(app).post("/api/auth/login").send({ email: "a@b.com", password: "whatever1" });
        }
        expect(last.status).toBe(429);
        expect(last.headers["retry-after"]).toBeDefined();
    });
});

describe("Organization data isolation", () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    test("GET /api/reviews only queries the caller's organization and batches reply lookups", async () => {
        const reviews = [reviewDoc({ orgId: orgA }), reviewDoc({ orgId: orgA })];
        const findReviews = jest.spyOn(Review, "find").mockReturnValue(queryResult(reviews));
        const findReplies = jest.spyOn(Reply, "find").mockResolvedValue([
            { reviewId: reviews[0]._id, status: "pending", draftReply: "Hi" },
        ]);
        const findOneReply = jest.spyOn(Reply, "findOne");

        const res = await request(app).get("/api/reviews").set("Authorization", `Bearer ${tokenFor(orgA)}`);

        expect(res.status).toBe(200);
        expect(findReviews).toHaveBeenCalledWith({ orgId: orgA.toString() });
        expect(findReplies).toHaveBeenCalledTimes(1);
        expect(findReplies).toHaveBeenCalledWith(expect.objectContaining({ orgId: orgA.toString() }));
        expect(findOneReply).not.toHaveBeenCalled();
        expect(res.body.reviews).toHaveLength(2);
        expect(res.body.reviews[0].reply.draftReply).toBe("Hi");
        expect(res.body.reviews[1].reply).toBeNull();
        expect(res.body.pagination).toBeUndefined();
    });

    test("GET /api/reviews supports opt-in pagination", async () => {
        const query = queryResult([reviewDoc({ orgId: orgA })]);
        jest.spyOn(Review, "find").mockReturnValue(query);
        jest.spyOn(Review, "countDocuments").mockResolvedValue(45);
        jest.spyOn(Reply, "find").mockResolvedValue([]);

        const res = await request(app)
            .get("/api/reviews?page=2&limit=20")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`);

        expect(res.status).toBe(200);
        expect(query.skip).toHaveBeenCalledWith(20);
        expect(query.limit).toHaveBeenCalledWith(20);
        expect(res.body.pagination).toEqual({
            page: 2, limit: 20, total: 45, totalPages: 3, hasNextPage: true, hasPrevPage: true,
        });
    });

    test("cannot read another organization's review", async () => {
        jest.spyOn(Review, "findById").mockReturnValue(queryResult(reviewDoc({ orgId: orgB })));
        const res = await request(app)
            .get(`/api/reviews/${new mongoose.Types.ObjectId()}`)
            .set("Authorization", `Bearer ${tokenFor(orgA)}`);
        expect(res.status).toBe(403);
    });

    test.each(["approve", "reject"])("cannot %s another organization's review", async (action) => {
        jest.spyOn(Review, "findById").mockResolvedValue(reviewDoc({ orgId: orgB }));
        const res = await request(app)
            .post(`/api/reply/${action}`)
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({ reviewId: new mongoose.Types.ObjectId().toString() });
        expect(res.status).toBe(403);
        expect(updateReviewReply).not.toHaveBeenCalled();
    });

    test("OpenAI key settings never return the key and reject non-boolean enabled", async () => {
        const org = { _id: orgA, openaiApiKey: "sk-secret-value-123", openaiEnabled: true, save: jest.fn() };
        jest.spyOn(Organization, "findById").mockReturnValue({ select: jest.fn().mockResolvedValue(org) });

        const bad = await request(app)
            .post("/api/organization/openai-key")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({ enabled: "false" });
        expect(bad.status).toBe(400);
        expect(org.save).not.toHaveBeenCalled();

        const ok = await request(app)
            .post("/api/organization/openai-key")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({ enabled: false });
        expect(ok.status).toBe(200);
        expect(ok.body.enabled).toBe(false);
        expect(JSON.stringify(ok.body)).not.toContain("sk-secret-value-123");
    });
});

describe("Reply status transitions", () => {
    const orgId = new mongoose.Types.ObjectId();
    const reviewId = new mongoose.Types.ObjectId();
    const locationId = new mongoose.Types.ObjectId();
    let review;

    function arrange(replyStatus, claimResult) {
        review = reviewDoc({
            _id: reviewId,
            orgId,
            locationId,
            googleReviewId: "g-1",
            googleResourceName: "accounts/1/locations/2/reviews/g-1",
        });
        jest.spyOn(Review, "findById").mockResolvedValue(review);
        mockPublishReady(orgId, locationId);
        let stored = { _id: new mongoose.Types.ObjectId(), orgId, reviewId, status: replyStatus, draftReply: "Draft" };
        jest.spyOn(Reply, "findOne").mockResolvedValue({ ...stored });
        return jest.spyOn(Reply, "findOneAndUpdate").mockImplementation((filter, update) => {
            if (claimResult !== undefined) return Promise.resolve(claimResult);
            stored = { ...stored, ...update.$set };
            return Promise.resolve({ ...stored });
        });
    }

    function approve(body = {}) {
        return request(app)
            .post("/api/reply/approve")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: reviewId.toString(), ...body });
    }

    test.each(["approved", "published", "rejected"])("approving a %s reply returns 409 and never republishes", async (status) => {
        const claim = arrange(status);
        const res = await approve();
        expect(res.status).toBe(409);
        expect(claim).not.toHaveBeenCalled();
        expect(updateReviewReply).not.toHaveBeenCalled();
    });

    test("concurrent approval that loses the atomic claim returns 409 without publishing", async () => {
        arrange("pending", null);
        const res = await approve();
        expect(res.status).toBe(409);
        expect(updateReviewReply).not.toHaveBeenCalled();
    });

    test("approval claims the reply only from pending status and publishes to Google", async () => {
        updateReviewReply.mockResolvedValue({ comment: "Edited reply" });
        const claim = arrange("pending");
        jest.spyOn(Reply, "findById").mockImplementation((id) =>
            Promise.resolve({
                _id: id,
                orgId,
                status: "published",
                publishState: "published",
                draftReply: "Draft",
                finalReply: "Edited reply",
            })
        );
        const res = await approve({ finalReply: "  Edited reply  " });
        expect(res.status).toBe(200);
        expect(claim).toHaveBeenCalledWith(
            expect.objectContaining({ status: "pending", orgId: orgId.toString() }),
            expect.objectContaining({
                $set: expect.objectContaining({ status: "approved", finalReply: "Edited reply", publishState: "sending" }),
            }),
            expect.anything()
        );
        expect(res.body.publishState).toBe("published");
        expect(updateReviewReply).toHaveBeenCalled();
    });

    test("missing Google connection does not change any status", async () => {
        const claim = arrange("pending");
        loadActiveConnectionForOrg.mockResolvedValue(null);
        const res = await approve();
        expect(res.status).toBe(500);
        expect(claim).not.toHaveBeenCalled();
        expect(review.save).not.toHaveBeenCalled();
    });

    test("definitive publishing failure returns the reply to pending with an error that the UI can show", async () => {
        updateReviewReply.mockRejectedValue(
            new GoogleApiError("unreachable", { status: 502, code: "ECONNREFUSED" })
        );
        // Force classify path via axios-style code on a plain error from publisher race
        updateReviewReply.mockRejectedValue(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }));
        arrange("pending");
        const res = await approve();
        expect(res.status).toBe(502);
        expect(res.body.publishState).toBe("failed");
        expect(res.body.reply.status).toBe("pending");
        expect(res.body.reply.publishState).toBe("failed");
        expect(res.body.reply.lastPublishError).toMatch(/unreachable|failed/i);
        expect(review.status).toBe("pending");
    });

    test.each(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"])(
        "ambiguous %s keeps the reply approved with publishState unknown (no automatic revert)",
        async (code) => {
            updateReviewReply.mockRejectedValue(Object.assign(new Error("ambiguous"), { code }));
            arrange("pending");
            const res = await approve();
            expect(res.status).toBe(202);
            expect(res.body.publishState).toBe("unknown");
            expect(res.body.reply.status).toBe("approved");
            expect(res.body.reply.publishState).toBe("unknown");
            expect(review.status).toBe("approved");
        }
    );

    test("a timed-out (unknown) reply cannot be re-approved through the normal approve path", async () => {
        arrange("approved");
        const res = await approve();
        expect(res.status).toBe(409);
        expect(updateReviewReply).not.toHaveBeenCalled();
    });

    test.each([
        [{ finalReply: 123 }, "finalReply must be a string"],
        [{ finalReply: "x".repeat(4097) }, "finalReply must be at most 4096 characters"],
        [{ reviewId: "bad-id" }, "Invalid review ID format"],
    ])("invalid approve payload %#", async (body, message) => {
        arrange("pending");
        const res = await approve(body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
    });

    test("rejecting a non-pending reply returns 409", async () => {
        arrange("approved");
        const res = await request(app)
            .post("/api/reply/reject")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: reviewId.toString() });
        expect(res.status).toBe(409);
        expect(review.status).toBe("pending");
    });

    test("rejecting a pending reply succeeds", async () => {
        arrange("pending");
        const res = await request(app)
            .post("/api/reply/reject")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ reviewId: reviewId.toString() });
        expect(res.status).toBe(200);
        expect(res.body.reply.status).toBe("rejected");
        expect(review.status).toBe("rejected");
    });
});

describe("Retired Make.com webhooks", () => {
    test("ingestion and publish-result endpoints return 410 Gone", async () => {
        const ingest = await request(app).post("/api/webhook/review").send({ reviewId: "x" });
        const publish = await request(app).post("/api/webhook/publish-result").send({ status: "published" });
        expect(ingest.status).toBe(410);
        expect(publish.status).toBe(410);
        expect(updateReviewReply).not.toHaveBeenCalled();
    });
});

describe("HTTP hardening", () => {
    test("malformed JSON returns a JSON 400 without a stack trace", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .set("Content-Type", "application/json")
            .send('{"email": ');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ success: false, message: "Request body must be valid JSON" });
    });

    test("unknown routes return a JSON 404", async () => {
        const res = await request(app).get("/api/does-not-exist");
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    test("in production, CORS headers are only sent to allowed origins", async () => {
        process.env.NODE_ENV = "production";
        try {
            const allowed = await request(app).get("/").set("Origin", "https://google-review-auto-reply.vercel.app");
            const blocked = await request(app).get("/").set("Origin", "https://evil.example.com");
            expect(allowed.headers["access-control-allow-origin"]).toBe("https://google-review-auto-reply.vercel.app");
            expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
        } finally {
            process.env.NODE_ENV = "test";
        }
    });
});
