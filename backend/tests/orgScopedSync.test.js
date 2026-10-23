const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

jest.mock("axios");
jest.mock("openai", () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: jest.fn() } },
    })),
}));

jest.mock("../services/reviewSync", () => {
    const actual = jest.requireActual("../services/reviewSync");
    return {
        ...actual,
        runOrganizationSync: jest.fn(),
        runReviewSyncCycle: jest.fn(),
        getSyncIntervalMs: actual.getSyncIntervalMs,
    };
});

const { runOrganizationSync, runReviewSyncCycle } = require("../services/reviewSync");
const googleRoutes = require("../routes/google");
const app = require("../index");

function tokenFor(orgId) {
    return jwt.sign({ organizationId: orgId }, "testsecret", { expiresIn: "1h" });
}

describe("POST /api/google/sync/now tenant isolation", () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        if (googleRoutes.syncNowLimiter) googleRoutes.syncNowLimiter.reset();
        runOrganizationSync.mockResolvedValue({
            orgId: String(orgA),
            locations: 1,
            created: 0,
            processed: 1,
            errors: 0,
            skippedUnlinked: 0,
            results: [{ locationId: "loc1", name: "A Cafe", ok: true, created: 0 }],
        });
    });

    test("uses authenticated org and never calls global runReviewSyncCycle", async () => {
        const res = await request(app)
            .post("/api/google/sync/now")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.summary.orgId).toBe(String(orgA));
        expect(runOrganizationSync).toHaveBeenCalledWith(orgA.toString());
        expect(runReviewSyncCycle).not.toHaveBeenCalled();
    });

    test("rejects attempts to sync another organization via body.orgId", async () => {
        const res = await request(app)
            .post("/api/google/sync/now")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({ orgId: orgB.toString() });

        expect(res.status).toBe(403);
        expect(runOrganizationSync).not.toHaveBeenCalled();
        expect(runReviewSyncCycle).not.toHaveBeenCalled();
    });

    test("does not process organization B when organization A syncs", async () => {
        runOrganizationSync.mockImplementation(async (orgId) => ({
            orgId: String(orgId),
            locations: String(orgId) === String(orgA) ? 1 : 0,
            created: 0,
            processed: 0,
            errors: 0,
            skippedUnlinked: 0,
            results:
                String(orgId) === String(orgA)
                    ? [{ locationId: "a1", ok: true, created: 0 }]
                    : [{ locationId: "b-should-not-appear", ok: true, created: 0 }],
        }));

        const res = await request(app)
            .post("/api/google/sync/now")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({ orgId: orgB.toString() });

        // body.orgId override blocked before sync
        expect(res.status).toBe(403);

        const ok = await request(app)
            .post("/api/google/sync/now")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({});

        expect(ok.status).toBe(200);
        expect(runOrganizationSync).toHaveBeenCalledTimes(1);
        expect(runOrganizationSync).toHaveBeenCalledWith(orgA.toString());
        expect(JSON.stringify(ok.body)).not.toContain("b-should-not-appear");
        expect(JSON.stringify(ok.body)).not.toContain(String(orgB));
    });

    test("failed location errors are sanitized (no foreign tenant payloads)", async () => {
        runOrganizationSync.mockResolvedValue({
            orgId: String(orgA),
            locations: 1,
            created: 0,
            processed: 0,
            errors: 1,
            skippedUnlinked: 3,
            results: [
                {
                    locationId: "loc-a",
                    ok: false,
                    message: "Location is not linked to an active Google connection",
                },
            ],
        });

        const res = await request(app)
            .post("/api/google/sync/now")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.summary.errors).toBe(1);
        expect(res.body.summary.results[0].message).not.toMatch(/orgB|other organization|token/i);
        expect(res.body.summary.skippedUnlinked).toBe(3);
    });

    test("rate limits repeated manual sync requests", async () => {
        let last;
        for (let i = 0; i < 6; i += 1) {
            last = await request(app)
                .post("/api/google/sync/now")
                .set("Authorization", `Bearer ${tokenFor(orgA)}`)
                .send({});
        }
        expect(last.status).toBe(429);
        expect(last.headers["retry-after"]).toBeDefined();
    });

    test("returns 409 when org sync is already in progress", async () => {
        runOrganizationSync.mockResolvedValue({
            skipped: true,
            reason: "org_sync_in_progress",
        });
        const res = await request(app)
            .post("/api/google/sync/now")
            .set("Authorization", `Bearer ${tokenFor(orgA)}`)
            .send({});
        expect(res.status).toBe(409);
        expect(res.body.skipped).toBe(true);
    });
});
