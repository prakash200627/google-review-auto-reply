const mongoose = require("mongoose");

jest.mock("../services/googleBusinessApi", () => ({
    listReviews: jest.fn(),
    parseStarRating: jest.requireActual("../services/googleBusinessApi").parseStarRating,
    extractReviewId: jest.requireActual("../services/googleBusinessApi").extractReviewId,
    GoogleApiError: jest.requireActual("../services/googleBusinessApi").GoogleApiError,
}));

jest.mock("../services/googleOAuth", () => ({
    getValidAccessToken: jest.fn().mockResolvedValue("token"),
    loadActiveConnectionForOrg: jest.fn(),
    isOAuthConfigured: jest.fn(() => true),
}));

jest.mock("../services/reviewProcessor", () => ({
    processIncomingReview: jest.fn(),
}));

const Location = require("../models/Location");
const SyncLease = require("../models/SyncLease");
const { listReviews } = require("../services/googleBusinessApi");
const { loadActiveConnectionForOrg, isOAuthConfigured } = require("../services/googleOAuth");
const { processIncomingReview } = require("../services/reviewProcessor");
const {
    getSyncIntervalMs,
    acquireLease,
    renewLease,
    releaseLease,
    syncLocation,
    runOrganizationSync,
    runReviewSyncCycle,
    orgLeaseKey,
    GLOBAL_LEASE_KEY,
    StaleLeaseError,
    writeLocationProgress,
    DEFAULT_INTERVAL_MINUTES,
    compareUpdateTime,
} = require("../services/reviewSync");

describe("reviewSync configuration", () => {
    test("defaults to 5 minutes for invalid values", () => {
        expect(getSyncIntervalMs({})).toBe(DEFAULT_INTERVAL_MINUTES * 60 * 1000);
        expect(getSyncIntervalMs({ REVIEW_SYNC_INTERVAL_MINUTES: "0" })).toBe(5 * 60 * 1000);
        expect(getSyncIntervalMs({ REVIEW_SYNC_INTERVAL_MINUTES: "abc" })).toBe(5 * 60 * 1000);
        expect(getSyncIntervalMs({ REVIEW_SYNC_INTERVAL_MINUTES: "10" })).toBe(10 * 60 * 1000);
    });

    test("compareUpdateTime orders ISO timestamps", () => {
        expect(compareUpdateTime("2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z")).toBe(-1);
        expect(compareUpdateTime("2024-01-02T00:00:00.000Z", "2024-01-02T00:00:00.000Z")).toBe(0);
    });
});

describe("fenced lease ownership", () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    test("acquireLease creates a unique owner token", async () => {
        jest.spyOn(SyncLease, "findOne").mockResolvedValue(null);
        jest.spyOn(SyncLease, "create").mockImplementation(async (doc) => ({ ...doc }));
        const lease = await acquireLease("test-key");
        expect(lease.ownerId).toEqual(expect.any(String));
        expect(lease.ownerId.length).toBeGreaterThan(16);
        expect(lease.generation).toBe(1);
    });

    test("acquireLease returns null when another owner holds a fresh lease", async () => {
        jest.spyOn(SyncLease, "findOne").mockResolvedValue({
            key: "test-key",
            ownerId: "other-owner",
            generation: 3,
            lockedUntil: new Date(Date.now() + 60_000),
        });
        const lease = await acquireLease("test-key");
        expect(lease).toBeNull();
    });

    test("acquireLease can take over an expired lease with generation bump", async () => {
        const expired = {
            key: "test-key",
            ownerId: "old-owner",
            generation: 2,
            lockedUntil: new Date(Date.now() - 1000),
        };
        jest.spyOn(SyncLease, "findOne").mockResolvedValue(expired);
        jest.spyOn(SyncLease, "findOneAndUpdate").mockResolvedValue({
            key: "test-key",
            ownerId: "new-owner",
            generation: 3,
            lockedUntil: new Date(Date.now() + 60_000),
        });
        const lease = await acquireLease("test-key", new Date());
        expect(lease.generation).toBe(3);
        expect(SyncLease.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                ownerId: "old-owner",
                generation: 2,
                lockedUntil: { $lte: expect.any(Date) },
            }),
            expect.objectContaining({
                $inc: { generation: 1 },
            }),
            expect.anything()
        );
    });

    test("renewLease fails for a stale owner", async () => {
        jest.spyOn(SyncLease, "findOneAndUpdate").mockResolvedValue(null);
        const ok = await renewLease({ key: "k", ownerId: "stale", generation: 1 });
        expect(ok).toBe(false);
    });

    test("renewLease succeeds only for matching owner and generation", async () => {
        jest.spyOn(SyncLease, "findOneAndUpdate").mockResolvedValue({
            key: "k",
            ownerId: "owner",
            generation: 5,
            lockedUntil: new Date(Date.now() + 60_000),
        });
        const fence = { key: "k", ownerId: "owner", generation: 5 };
        expect(await renewLease(fence)).toBe(true);
        expect(SyncLease.findOneAndUpdate).toHaveBeenCalledWith(
            { key: "k", ownerId: "owner", generation: 5 },
            expect.any(Object),
            expect.anything()
        );
    });

    test("releaseLease deletes only the owning fence", async () => {
        const del = jest.spyOn(SyncLease, "deleteOne").mockResolvedValue({ deletedCount: 1 });
        await releaseLease({ key: "k", ownerId: "owner", generation: 2 });
        expect(del).toHaveBeenCalledWith({ key: "k", ownerId: "owner", generation: 2 });
    });

    test("writeLocationProgress refuses writes after fence loss", async () => {
        jest.spyOn(SyncLease, "findOneAndUpdate").mockResolvedValue(null);
        const locUpdate = jest.spyOn(Location, "findOneAndUpdate");
        await expect(
            writeLocationProgress(
                { _id: new mongoose.Types.ObjectId(), orgId: new mongoose.Types.ObjectId() },
                { key: "k", ownerId: "stale", generation: 1 },
                { lastSyncError: "x" }
            )
        ).rejects.toBeInstanceOf(StaleLeaseError);
        expect(locUpdate).not.toHaveBeenCalled();
    });
});

describe("syncLocation watermark and fencing", () => {
    const orgId = new mongoose.Types.ObjectId();
    const connectionId = new mongoose.Types.ObjectId();
    const fence = { key: orgLeaseKey(orgId), ownerId: "owner-1", generation: 1 };
    const PRIOR_WATERMARK = "2024-01-01T00:00:00.000Z";
    let location;
    let persisted;

    function review(id, updateTime, starRating = "FIVE") {
        return {
            name: `accounts/acc/locations/loc/reviews/${id}`,
            reviewId: id,
            starRating,
            comment: id,
            updateTime,
            reviewer: { displayName: id },
        };
    }

    function installPersistence() {
        persisted = {
            ...location,
            syncFenceToken: "",
        };
        jest.spyOn(Location, "findOneAndUpdate").mockImplementation(async (filter, update) => {
            // Progress writes include syncFenceToken in the filter; refuse stale owners.
            if (
                Object.prototype.hasOwnProperty.call(filter, "syncFenceToken") &&
                filter.syncFenceToken !== persisted.syncFenceToken &&
                !(update.$set && update.$set.syncFenceToken === filter.syncFenceToken)
            ) {
                // Allow claim (no syncFenceToken in filter) and first fence set.
                if (persisted.syncFenceToken && filter.syncFenceToken !== persisted.syncFenceToken) {
                    return null;
                }
            }
            persisted = { ...persisted, ...(update.$set || {}) };
            return { ...persisted };
        });
    }

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        location = {
            _id: new mongoose.Types.ObjectId(),
            orgId,
            connectionId,
            googleAccountId: "acc",
            googleLocationId: "loc",
            syncCheckpointPageToken: "",
            syncWatermarkUpdateTime: PRIOR_WATERMARK,
            syncPassIncomplete: false,
            name: "Cafe",
        };
        jest.spyOn(SyncLease, "findOneAndUpdate").mockResolvedValue({
            ...fence,
            lockedUntil: new Date(Date.now() + 60_000),
        });
        installPersistence();
        loadActiveConnectionForOrg.mockResolvedValue({ _id: connectionId, orgId, status: "active" });
    });

    test("completely successful pass advances watermark and clears checkpoint", async () => {
        listReviews.mockResolvedValue({
            reviews: [
                review("new", "2024-06-01T00:00:00.000Z"),
                review("old", "2023-01-01T00:00:00.000Z", "FOUR"),
            ],
            nextPageToken: "should-not-fetch",
        });
        processIncomingReview.mockResolvedValue({ created: true });

        const result = await syncLocation(location, fence);
        expect(result.ok).toBe(true);
        expect(result.stoppedAtWatermark).toBe(true);
        expect(processIncomingReview).toHaveBeenCalledTimes(1);
        expect(listReviews).toHaveBeenCalledTimes(1);
        expect(persisted.syncWatermarkUpdateTime).toBe("2024-06-01T00:00:00.000Z");
        expect(persisted.syncCheckpointPageToken).toBe("");
        expect(persisted.syncPassIncomplete).toBe(false);
        expect(persisted.lastSyncError).toBe("");
    });

    test("newer succeeds, middle fails, older succeeds: watermark does not advance past failure", async () => {
        listReviews.mockResolvedValue({
            reviews: [
                review("t3", "2024-03-01T00:00:00.000Z"),
                review("t2", "2024-02-01T00:00:00.000Z"),
                review("t1", "2024-01-15T00:00:00.000Z"),
            ],
            nextPageToken: "",
        });
        processIncomingReview
            .mockResolvedValueOnce({ created: true }) // t3
            .mockRejectedValueOnce(new Error("boom")) // t2
            .mockResolvedValueOnce({ created: true }); // t1

        const result = await syncLocation(location, fence);
        expect(result.ok).toBe(false);
        expect(result.partialFailure).toBe(true);
        expect(persisted.syncWatermarkUpdateTime).toBe(PRIOR_WATERMARK);
        expect(persisted.syncCheckpointPageToken).toBe("");
        expect(persisted.syncPassIncomplete).toBe(true);
        expect(persisted.lastSyncError).toMatch(/Partial sync incomplete/i);
        expect(persisted).not.toHaveProperty("syncWatermarkUpdateTime", "2024-03-01T00:00:00.000Z");
    });

    test("failed review is retried on a subsequent sync while prior watermark is retained", async () => {
        listReviews
            .mockResolvedValueOnce({
                reviews: [
                    review("t3", "2024-03-01T00:00:00.000Z"),
                    review("t2", "2024-02-01T00:00:00.000Z"),
                ],
                nextPageToken: "",
            })
            .mockResolvedValueOnce({
                reviews: [
                    review("t3", "2024-03-01T00:00:00.000Z"),
                    review("t2", "2024-02-01T00:00:00.000Z"),
                    review("ancient", "2023-01-01T00:00:00.000Z"),
                ],
                nextPageToken: "",
            });
        processIncomingReview
            .mockResolvedValueOnce({ created: true })
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce({ created: false }) // t3 idempotent
            .mockResolvedValueOnce({ created: true }); // t2 retry

        const first = await syncLocation(location, fence);
        expect(first.partialFailure).toBe(true);
        expect(persisted.syncWatermarkUpdateTime).toBe(PRIOR_WATERMARK);
        expect(persisted.syncPassIncomplete).toBe(true);

        // Second pass uses persisted watermark/checkpoint/incomplete from first failure.
        location.syncWatermarkUpdateTime = persisted.syncWatermarkUpdateTime;
        location.syncCheckpointPageToken = persisted.syncCheckpointPageToken;
        location.syncPassIncomplete = persisted.syncPassIncomplete;

        const second = await syncLocation(location, fence);
        expect(second.ok).toBe(true);
        expect(processIncomingReview.mock.calls.map((c) => c[0].googleReviewId)).toEqual(
            expect.arrayContaining(["t3", "t2", "t3", "t2"])
        );
        expect(persisted.syncWatermarkUpdateTime).toBe("2024-03-01T00:00:00.000Z");
        expect(persisted.syncCheckpointPageToken).toBe("");
        expect(persisted.syncPassIncomplete).toBe(false);
    });

    test("page-fetch failure cannot advance the watermark", async () => {
        const { GoogleApiError } = require("../services/googleBusinessApi");
        listReviews.mockRejectedValue(new GoogleApiError("quota", { status: 429, code: "transient" }));

        const result = await syncLocation(location, fence);
        expect(result.ok).toBe(false);
        expect(persisted.syncWatermarkUpdateTime).toBe(PRIOR_WATERMARK);
        const watermarkWrites = Location.findOneAndUpdate.mock.calls.filter(
            (c) => c[1] && c[1].$set && Object.prototype.hasOwnProperty.call(c[1].$set, "syncWatermarkUpdateTime")
        );
        expect(watermarkWrites).toHaveLength(0);
    });

    test("lease-fencing failure cannot advance watermark or persist stale progress", async () => {
        listReviews.mockResolvedValue({
            reviews: [review("r1", "2024-06-01T00:00:00.000Z")],
            nextPageToken: "",
        });
        let renewCount = 0;
        SyncLease.findOneAndUpdate.mockImplementation(async () => {
            renewCount += 1;
            if (renewCount <= 2) {
                return { ...fence, lockedUntil: new Date(Date.now() + 60_000) };
            }
            return null;
        });

        const result = await syncLocation(location, fence);
        expect(result.stale).toBe(true);
        expect(result.ok).toBe(false);
        expect(persisted.syncWatermarkUpdateTime).toBe(PRIOR_WATERMARK);
        const watermarkWrites = Location.findOneAndUpdate.mock.calls.filter(
            (c) => c[1] && c[1].$set && Object.prototype.hasOwnProperty.call(c[1].$set, "syncWatermarkUpdateTime")
        );
        expect(watermarkWrites).toHaveLength(0);
    });

    test("page-token checkpoint recovery finishes chain then can advance watermark only if clean", async () => {
        location.syncCheckpointPageToken = "page-2";
        location.syncPassIncomplete = false;
        installPersistence();
        persisted.syncCheckpointPageToken = "page-2";
        persisted.syncPassIncomplete = false;

        listReviews
            .mockResolvedValueOnce({
                reviews: [review("p2a", "2024-05-01T00:00:00.000Z")],
                nextPageToken: "",
            });
        processIncomingReview.mockResolvedValue({ created: true });

        const result = await syncLocation(location, fence);
        expect(result.ok).toBe(true);
        expect(listReviews).toHaveBeenCalledWith(
            "token",
            "acc",
            "loc",
            expect.objectContaining({ pageToken: "page-2" })
        );
        expect(persisted.syncCheckpointPageToken).toBe("");
        expect(persisted.syncPassIncomplete).toBe(false);
        expect(persisted.syncWatermarkUpdateTime).toBe("2024-05-01T00:00:00.000Z");
    });

    test("checkpoint recovery with a processing failure retains prior watermark and clears token", async () => {
        location.syncCheckpointPageToken = "page-2";
        installPersistence();
        persisted.syncCheckpointPageToken = "page-2";

        listReviews.mockResolvedValue({
            reviews: [
                review("ok", "2024-05-02T00:00:00.000Z"),
                review("bad", "2024-05-01T00:00:00.000Z"),
            ],
            nextPageToken: "",
        });
        processIncomingReview
            .mockResolvedValueOnce({ created: true })
            .mockRejectedValueOnce(new Error("persist failed"));

        const result = await syncLocation(location, fence);
        expect(result.partialFailure).toBe(true);
        expect(persisted.syncWatermarkUpdateTime).toBe(PRIOR_WATERMARK);
        expect(persisted.syncCheckpointPageToken).toBe("");
        expect(persisted.syncPassIncomplete).toBe(true);
    });

    test.each([
        ["missing_review_id", { name: "accounts/acc/locations/loc", starRating: "FIVE", updateTime: "2024-06-01T00:00:00.000Z" }],
        ["missing_rating", { name: "accounts/acc/locations/loc/reviews/r1", reviewId: "r1", starRating: "STAR_RATING_UNSPECIFIED", updateTime: "2024-06-01T00:00:00.000Z" }],
        ["missing_resource_name", { reviewId: "r1", starRating: "FIVE", updateTime: "2024-06-01T00:00:00.000Z", name: "" }],
    ])("malformed %s is observable and does not advance watermark", async (reason, payload) => {
        listReviews.mockResolvedValue({
            reviews: [payload, review("ok", "2024-05-01T00:00:00.000Z")],
            nextPageToken: "",
        });
        processIncomingReview.mockResolvedValue({ created: true });

        const result = await syncLocation(location, fence);
        expect(result.ok).toBe(false);
        expect(result.partialFailure).toBe(true);
        expect(result.malformed).toBe(true);
        expect(result.malformedCount).toBe(1);
        expect(result.malformedReasons[reason]).toBe(1);
        expect(persisted.syncWatermarkUpdateTime).toBe(PRIOR_WATERMARK);
        expect(persisted.syncPassIncomplete).toBe(true);
        expect(persisted.lastSyncError).toMatch(/malformed/i);
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("review_sync_malformed_payload")
        );
        const warnPayload = JSON.parse(console.warn.mock.calls[0][0]);
        expect(warnPayload).toMatchObject({
            event: "review_sync_malformed_payload",
            locationId: String(location._id),
            count: 1,
            reasons: expect.objectContaining({ [reason]: 1 }),
        });
        expect(warnPayload).not.toHaveProperty("comment");
        expect(warnPayload).not.toHaveProperty("reviewer");
    });

    test("duplicate review is distinguishable from malformed input", async () => {
        listReviews.mockResolvedValue({
            reviews: [review("dup", "2024-06-01T00:00:00.000Z")],
            nextPageToken: "",
        });
        processIncomingReview.mockResolvedValue({ created: false });

        const result = await syncLocation(location, fence);
        expect(result.ok).toBe(true);
        expect(result.skippedDuplicates).toBe(1);
        expect(result.malformedCount).toBe(0);
        expect(result.partialFailure).toBeUndefined();
        expect(persisted.syncWatermarkUpdateTime).toBe("2024-06-01T00:00:00.000Z");
        expect(persisted.syncPassIncomplete).toBe(false);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test("crash after incomplete marker before cleanup does not skip failed review on resume", async () => {
        // Page 1 fails mid-pass after durable incomplete marker; then lease dies
        // before final cleanup — simulating process interruption.
        listReviews
            .mockResolvedValueOnce({
                reviews: [
                    review("t3", "2024-03-01T00:00:00.000Z"),
                    review("t2", "2024-02-01T00:00:00.000Z"),
                ],
                nextPageToken: "page-2",
            })
            .mockResolvedValueOnce({
                // Resume must start from newest (ignore any leftover page-2 token).
                reviews: [
                    review("t3", "2024-03-01T00:00:00.000Z"),
                    review("t2", "2024-02-01T00:00:00.000Z"),
                    review("ancient", "2023-01-01T00:00:00.000Z"),
                ],
                nextPageToken: "",
            });
        processIncomingReview
            .mockResolvedValueOnce({ created: true }) // t3
            .mockRejectedValueOnce(new Error("boom")) // t2 — triggers incomplete marker
            .mockResolvedValueOnce({ created: false }) // t3 resume
            .mockResolvedValueOnce({ created: true }); // t2 resume

        let renewCount = 0;
        SyncLease.findOneAndUpdate.mockImplementation(async () => {
            renewCount += 1;
            // Allow claim + first page work + incomplete marker writes, then die
            // before continuing to page-2 / final cleanup.
            if (renewCount <= 6) {
                return { ...fence, lockedUntil: new Date(Date.now() + 60_000) };
            }
            return null;
        });

        const interrupted = await syncLocation(location, fence);
        expect(interrupted.stale || interrupted.partialFailure || !interrupted.ok).toBe(true);
        expect(persisted.syncPassIncomplete).toBe(true);
        expect(persisted.syncCheckpointPageToken).toBe("");
        expect(persisted.syncWatermarkUpdateTime).toBe(PRIOR_WATERMARK);

        // Simulate leftover stale checkpoint that must be ignored because incomplete=true.
        persisted.syncCheckpointPageToken = "page-2";
        location.syncPassIncomplete = true;
        location.syncCheckpointPageToken = "page-2";
        location.syncWatermarkUpdateTime = PRIOR_WATERMARK;

        SyncLease.findOneAndUpdate.mockResolvedValue({
            ...fence,
            lockedUntil: new Date(Date.now() + 60_000),
        });

        const resumed = await syncLocation(location, fence);
        expect(resumed.ok).toBe(true);
        expect(listReviews.mock.calls[1][3]).not.toEqual(
            expect.objectContaining({ pageToken: "page-2" })
        );
        expect(processIncomingReview.mock.calls.map((c) => c[0].googleReviewId)).toEqual(
            expect.arrayContaining(["t3", "t2", "t3", "t2"])
        );
        expect(persisted.syncWatermarkUpdateTime).toBe("2024-03-01T00:00:00.000Z");
        expect(persisted.syncPassIncomplete).toBe(false);
    });

    test("lease takeover prevents old worker from modifying recovery markers", async () => {
        listReviews.mockResolvedValue({
            reviews: [review("t2", "2024-02-01T00:00:00.000Z")],
            nextPageToken: "",
        });
        processIncomingReview.mockRejectedValue(new Error("boom"));

        // After claim sets fence to owner-1, a newer worker takes over.
        const originalImpl = Location.findOneAndUpdate.getMockImplementation();
        Location.findOneAndUpdate.mockImplementation(async (filter, update) => {
            const result = await originalImpl(filter, update);
            if (update && update.$set && update.$set.syncFenceToken === fence.ownerId) {
                persisted.syncFenceToken = "newer-owner";
                return { ...persisted, syncFenceToken: fence.ownerId };
            }
            if (
                Object.prototype.hasOwnProperty.call(filter, "syncFenceToken") &&
                filter.syncFenceToken === fence.ownerId &&
                persisted.syncFenceToken !== fence.ownerId
            ) {
                return null;
            }
            return result;
        });

        const before = {
            watermark: persisted.syncWatermarkUpdateTime,
            incomplete: persisted.syncPassIncomplete,
            checkpoint: persisted.syncCheckpointPageToken,
        };

        const result = await syncLocation(location, fence);
        expect(result.ok).toBe(false);
        expect(result.stale).toBe(true);
        // Newer owner's recovery state must not be cleared/advanced by the stale worker.
        expect(persisted.syncFenceToken).toBe("newer-owner");
        expect(persisted.syncWatermarkUpdateTime).toBe(before.watermark);
        expect(persisted.syncPassIncomplete).toBe(before.incomplete);
        expect(persisted.syncCheckpointPageToken).toBe(before.checkpoint);
        const watermarkWrites = Location.findOneAndUpdate.mock.calls.filter(
            (c) =>
                c[0].syncFenceToken === fence.ownerId &&
                c[1] &&
                c[1].$set &&
                Object.prototype.hasOwnProperty.call(c[1].$set, "syncWatermarkUpdateTime")
        );
        expect(watermarkWrites).toHaveLength(0);
    });
});

describe("organization-scoped vs global sync", () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        isOAuthConfigured.mockReturnValue(true);
    });

    test("runOrganizationSync only loads locations for that org", async () => {
        const fence = { key: orgLeaseKey(orgA), ownerId: "o", generation: 1, lockedUntil: new Date() };
        jest.spyOn(SyncLease, "findOne").mockResolvedValue(null);
        jest.spyOn(SyncLease, "create").mockResolvedValue(fence);
        jest.spyOn(SyncLease, "findOneAndUpdate").mockResolvedValue({
            ...fence,
            lockedUntil: new Date(Date.now() + 60_000),
        });
        jest.spyOn(SyncLease, "deleteOne").mockResolvedValue({});
        jest.spyOn(Location, "find").mockResolvedValue([]);
        jest.spyOn(Location, "countDocuments").mockResolvedValue(2);

        await runOrganizationSync(orgA);

        expect(Location.find).toHaveBeenCalledWith(
            expect.objectContaining({ orgId: orgA, syncEnabled: true })
        );
        expect(Location.find).not.toHaveBeenCalledWith(
            expect.objectContaining({ orgId: orgB })
        );
    });

    test("runReviewSyncCycle processes each eligible organization", async () => {
        jest.spyOn(SyncLease, "findOne").mockResolvedValue(null);
        jest.spyOn(SyncLease, "create").mockImplementation(async (doc) => ({
            ...doc,
            lockedUntil: new Date(Date.now() + 60_000),
        }));
        jest.spyOn(SyncLease, "findOneAndUpdate").mockImplementation(async (filter, update) => ({
            key: filter.key || GLOBAL_LEASE_KEY,
            ownerId: filter.ownerId || "x",
            generation: filter.generation || 1,
            lockedUntil: new Date(Date.now() + 60_000),
            ...(update && update.$set),
        }));
        jest.spyOn(SyncLease, "deleteOne").mockResolvedValue({});
        jest.spyOn(Location, "distinct").mockResolvedValue([orgA, orgB]);
        jest.spyOn(Location, "find").mockResolvedValue([]);
        jest.spyOn(Location, "countDocuments").mockResolvedValue(0);

        const summary = await runReviewSyncCycle();
        expect(summary.skipped).toBeUndefined();
        expect(summary.organizations).toBe(2);
        expect(summary.orgSummaries).toHaveLength(2);
        expect(summary.orgSummaries.map((s) => s.orgId).sort()).toEqual(
            [String(orgA), String(orgB)].sort()
        );
    });

    test("runReviewSyncCycle skips when OAuth is not configured", async () => {
        isOAuthConfigured.mockReturnValue(false);
        const result = await runReviewSyncCycle();
        expect(result).toEqual({ skipped: true, reason: "oauth_not_configured" });
    });
});
