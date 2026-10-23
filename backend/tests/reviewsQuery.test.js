const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Review = require("../models/Review");
const Reply = require("../models/Reply");
const app = require("../index");

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const tokenA = jwt.sign({ organizationId: orgA }, "testsecret", { expiresIn: "1h" });

function queryResult(result) {
    const query = {
        populate: jest.fn(() => query),
        sort: jest.fn(() => query),
        skip: jest.fn(() => query),
        limit: jest.fn(() => query),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return query;
}

function reviewDoc(orgId) {
    const doc = { _id: new mongoose.Types.ObjectId(), orgId, status: "pending", rating: 5 };
    doc.toObject = () => ({ _id: doc._id, orgId: doc.orgId, status: doc.status, rating: doc.rating });
    return doc;
}

let findSpy;
let countSpy;
let lastQuery;

beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    findSpy = jest.spyOn(Review, "find").mockImplementation(() => {
        lastQuery = queryResult([reviewDoc(orgA)]);
        return lastQuery;
    });
    countSpy = jest.spyOn(Review, "countDocuments").mockResolvedValue(250);
    jest.spyOn(Reply, "find").mockResolvedValue([]);
});

function get(path) {
    return request(app).get(path).set("Authorization", `Bearer ${tokenA}`);
}

describe("GET /api/reviews pagination", () => {
    test("without parameters the response is unchanged: all reviews, no pagination block", async () => {
        const res = await get("/api/reviews");
        expect(res.status).toBe(200);
        expect(res.body.pagination).toBeUndefined();
        expect(lastQuery.skip).not.toHaveBeenCalled();
        expect(lastQuery.limit).not.toHaveBeenCalled();
        expect(countSpy).not.toHaveBeenCalled();
    });

    test("uses a deterministic sort with an _id tie-breaker", async () => {
        await get("/api/reviews?page=1");
        expect(lastQuery.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    });

    test.each([
        ["page=1&limit=1", 1, 1, 0],
        ["page=1&limit=100", 1, 100, 0],
        ["page=3&limit=100", 3, 100, 200],
        ["page=2", 2, 20, 20],
        ["limit=50", 1, 50, 0],
        ["page=10000&limit=1", 10000, 1, 9999],
    ])("accepts boundary %s", async (qs, page, limit, skip) => {
        const res = await get(`/api/reviews?${qs}`);
        expect(res.status).toBe(200);
        expect(lastQuery.skip).toHaveBeenCalledWith(skip);
        expect(lastQuery.limit).toHaveBeenCalledWith(limit);
        expect(res.body.pagination).toMatchObject({ page, limit, total: 250, totalPages: Math.ceil(250 / limit) });
    });

    test("pagination metadata reports next/previous pages", async () => {
        const last = await get("/api/reviews?page=3&limit=100");
        expect(last.body.pagination).toMatchObject({ hasNextPage: false, hasPrevPage: true });
        const first = await get("/api/reviews?page=1&limit=100");
        expect(first.body.pagination).toMatchObject({ hasNextPage: true, hasPrevPage: false });
    });

    test.each([
        "page=0",
        "page=-1",
        "page=1.5",
        "page=abc",
        "page=",
        "page=10001",
        "limit=0",
        "limit=101",
        "limit=1e2",
        "limit=%2010",
        "page=1&page=2",
    ])("rejects invalid parameter %s with 400", async (qs) => {
        const res = await get(`/api/reviews?${qs}`);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(findSpy).not.toHaveBeenCalled();
    });
});

describe("GET /api/reviews filtering", () => {
    test("applies every filter together with the caller's organization", async () => {
        const locationId = new mongoose.Types.ObjectId().toString();
        const res = await get(`/api/reviews?status=approved&sentiment=negative&rating=2&locationId=${locationId}&page=1&limit=10`);
        expect(res.status).toBe(200);
        expect(findSpy).toHaveBeenCalledWith({
            orgId: orgA.toString(),
            status: "approved",
            sentiment: "negative",
            rating: 2,
            locationId,
        });
        expect(countSpy).toHaveBeenCalledWith(findSpy.mock.calls[0][0]);
    });

    test("filters work without pagination and keep the legacy response shape", async () => {
        const res = await get("/api/reviews?sentiment=positive");
        expect(res.status).toBe(200);
        expect(res.body.pagination).toBeUndefined();
        expect(findSpy).toHaveBeenCalledWith({ orgId: orgA.toString(), sentiment: "positive" });
    });

    test("search is case-insensitive and treats regex characters literally", async () => {
        await get("/api/reviews?search=" + encodeURIComponent("a.b*(c"));
        const filter = findSpy.mock.calls[0][0];
        const [byName, byText] = filter.$or;
        expect(byName.reviewerName.flags).toContain("i");
        expect(byName.reviewerName.test("A.B*(C")).toBe(true);
        expect(byName.reviewerName.test("axb*(c")).toBe(false);
        expect(byText.text.source).toBe(byName.reviewerName.source);
    });

    test("blank search is ignored", async () => {
        await get("/api/reviews?search=%20%20");
        expect(findSpy).toHaveBeenCalledWith({ orgId: orgA.toString() });
    });

    test.each([
        "status=deleted",
        "sentiment=angry",
        "rating=6",
        "rating=0",
        "locationId=not-an-id",
        "search=" + "x".repeat(101),
        "rating=1&rating=2",
    ])("rejects invalid filter %s with 400", async (qs) => {
        const res = await get(`/api/reviews?${qs}`);
        expect(res.status).toBe(400);
        expect(findSpy).not.toHaveBeenCalled();
    });

    test("bracket syntax is never parsed into query operators", async () => {
        const res = await get("/api/reviews?status[$ne]=pending&limit[$gt]=1");
        expect(res.status).toBe(200);
        expect(findSpy).toHaveBeenCalledWith({ orgId: orgA.toString() });
        expect(res.body.pagination).toBeUndefined();
    });

    test("/pending always scopes to pending and rejects a status override", async () => {
        const ok = await get("/api/reviews/pending?page=1&limit=5&rating=1");
        expect(ok.status).toBe(200);
        expect(findSpy).toHaveBeenCalledWith({ orgId: orgA.toString(), status: "pending", rating: 1 });

        findSpy.mockClear();
        const bad = await get("/api/reviews/pending?status=approved");
        expect(bad.status).toBe(400);
        expect(findSpy).not.toHaveBeenCalled();
    });
});

describe("cross-organization isolation", () => {
    test.each([
        `orgId=${orgB}`,
        `orgId=${orgB}&page=1`,
        `locationId=${new mongoose.Types.ObjectId()}&orgId=${orgB}`,
    ])("query parameters cannot widen the organization scope (%s)", async (qs) => {
        await get(`/api/reviews?${qs}`);
        const filter = findSpy.mock.calls[0][0];
        expect(filter.orgId).toBe(orgA.toString());
        expect(JSON.stringify(filter)).not.toContain(orgB.toString());
    });

    test("reply lookups are scoped to the caller's organization", async () => {
        await get("/api/reviews?page=1&limit=10");
        expect(Reply.find).toHaveBeenCalledWith(expect.objectContaining({ orgId: orgA.toString() }));
    });

    test("count queries use the same organization-scoped filter", async () => {
        await get("/api/reviews?page=2&limit=10&rating=5");
        expect(countSpy).toHaveBeenCalledWith({ orgId: orgA.toString(), rating: 5 });
    });
});
