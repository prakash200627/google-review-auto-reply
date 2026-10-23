const crypto = require("crypto");

const Location = require("../models/Location");
const SyncLease = require("../models/SyncLease");
const {
    getValidAccessToken,
    loadActiveConnectionForOrg,
    isOAuthConfigured,
} = require("./googleOAuth");
const {
    listReviews,
    parseStarRating,
    extractReviewId,
    GoogleApiError,
} = require("./googleBusinessApi");
const { processIncomingReview } = require("./reviewProcessor");

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60;
const GLOBAL_LEASE_KEY = "review-sync";
// Long enough for a slow page + AI burst; ownership is still fenced by ownerId.
const LEASE_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

class StaleLeaseError extends Error {
    constructor(message = "Sync lease ownership lost") {
        super(message);
        this.name = "StaleLeaseError";
        this.code = "stale_lease";
    }
}

let globalCycleRunning = false;
let intervalHandle = null;

function getSyncIntervalMs(env = process.env) {
    const raw = (env.REVIEW_SYNC_INTERVAL_MINUTES || "").trim();
    const minutes = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const valid = minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES;
    return (valid ? minutes : DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
}

function orgLeaseKey(orgId) {
    return `review-sync:org:${String(orgId)}`;
}

function newOwnerId() {
    return `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Acquire a lease with a unique fencing token.
 * Returns { key, ownerId, generation, lockedUntil } or null if held by another owner.
 */
async function acquireLease(key, now = new Date()) {
    const ownerId = newOwnerId();
    const lockedUntil = new Date(now.getTime() + LEASE_TTL_MS);

    // Take over only when expired (or create). Never steal a fresh lease.
    const existing = await SyncLease.findOne({ key });
    if (existing && existing.lockedUntil > now) {
        return null;
    }

    if (existing) {
        const leased = await SyncLease.findOneAndUpdate(
            {
                key,
                ownerId: existing.ownerId,
                generation: existing.generation,
                lockedUntil: { $lte: now },
            },
            {
                $set: { ownerId, lockedUntil },
                $inc: { generation: 1 },
            },
            { returnDocument: "after" }
        );
        if (leased) {
            return {
                key: leased.key,
                ownerId: leased.ownerId,
                generation: leased.generation,
                lockedUntil: leased.lockedUntil,
            };
        }
        return null;
    }

    try {
        const created = await SyncLease.create({
            key,
            ownerId,
            generation: 1,
            lockedUntil,
        });
        return {
            key: created.key,
            ownerId: created.ownerId,
            generation: created.generation,
            lockedUntil: created.lockedUntil,
        };
    } catch (err) {
        if (err && err.code === 11000) return null;
        throw err;
    }
}

async function renewLease(fence, now = new Date()) {
    if (!fence || !fence.key || !fence.ownerId) return false;
    const lockedUntil = new Date(now.getTime() + LEASE_TTL_MS);
    const renewed = await SyncLease.findOneAndUpdate(
        {
            key: fence.key,
            ownerId: fence.ownerId,
            generation: fence.generation,
        },
        { $set: { lockedUntil } },
        { returnDocument: "after" }
    );
    if (!renewed) return false;
    fence.lockedUntil = renewed.lockedUntil;
    return true;
}

async function releaseLease(fence) {
    if (!fence || !fence.key || !fence.ownerId) return;
    await SyncLease.deleteOne({
        key: fence.key,
        ownerId: fence.ownerId,
        generation: fence.generation,
    });
}

async function assertLease(fence) {
    if (!(await renewLease(fence))) {
        throw new StaleLeaseError();
    }
}

/** Persist location sync fields only while this fence still owns the location. */
async function writeLocationProgress(location, fence, fields) {
    await assertLease(fence);
    const updated = await Location.findOneAndUpdate(
        {
            _id: location._id,
            orgId: location.orgId,
            syncFenceToken: fence.ownerId,
        },
        { $set: fields },
        { returnDocument: "after" }
    );
    if (!updated) {
        throw new StaleLeaseError("Lost location sync fence; refusing to write progress");
    }
    return updated;
}

async function claimLocationFence(location, fence) {
    // Only the holder of the org lease reaches here. Overwrite any orphaned
    // fence from a crashed worker; progress writes still require this ownerId.
    await assertLease(fence);
    return Location.findOneAndUpdate(
        {
            _id: location._id,
            orgId: location.orgId,
        },
        {
            $set: {
                syncFenceToken: fence.ownerId,
                lastSyncAttemptAt: new Date(),
                lastSyncError: "",
            },
        },
        { returnDocument: "after" }
    );
}

function parseGoogleUpdateTime(value) {
    if (!value) return null;
    if (typeof value === "string") {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? value : null;
    }
    if (typeof value === "object" && value.seconds != null) {
        const ms = Number(value.seconds) * 1000 + Math.floor((Number(value.nanos) || 0) / 1e6);
        return new Date(ms).toISOString();
    }
    return null;
}

function compareUpdateTime(a, b) {
    const am = Date.parse(a || "");
    const bm = Date.parse(b || "");
    if (!Number.isFinite(am) && !Number.isFinite(bm)) return 0;
    if (!Number.isFinite(am)) return -1;
    if (!Number.isFinite(bm)) return 1;
    return am === bm ? 0 : am < bm ? -1 : 1;
}

function classifyMalformedReview(googleReview) {
    const reasons = [];
    const googleReviewId = extractReviewId(googleReview);
    const rating = parseStarRating(googleReview.starRating);
    const resourceName = googleReview.name || "";
    if (!googleReviewId) reasons.push("missing_review_id");
    if (!rating) reasons.push("missing_rating");
    if (!resourceName) reasons.push("missing_resource_name");
    return {
        ok: reasons.length === 0,
        reasons,
        googleReviewId,
        rating,
        resourceName,
    };
}

function logMalformedSummary(locationId, malformedReasons, total) {
    if (!total) return;
    // Sanitized only: location id, reason codes, counts — no tokens, comments, or PII.
    console.warn(
        JSON.stringify({
            event: "review_sync_malformed_payload",
            locationId: String(locationId),
            count: total,
            reasons: malformedReasons,
        })
    );
}

/**
 * Sync a single location under an owned lease fence.
 *
 * Watermark strategy (conservative; Google list is not a transactional snapshot):
 * - Process newest-first pages (`updateTime desc`).
 * - Stop when a review's updateTime is strictly older than the stored watermark
 *   (equality is re-processed; ingest is idempotent).
 * - Advance `syncWatermarkUpdateTime` ONLY after a pass with zero processing
 *   failures AND zero malformed payloads, while still owning the fence.
 * - On processing failure or malformed payload: durably set `syncPassIncomplete`,
 *   clear `syncCheckpointPageToken` immediately (before further pages), and keep
 *   the previous watermark so reviews remain reachable on the next newest-first walk.
 * - If `syncPassIncomplete` is already set (prior crash), ignore any leftover
 *   page-token and restart from newest — do not resume past a failed review.
 * - Clean page-token recovery (incomplete=false) still finishes that chain without
 *   early-stop; watermark advances only if that recovery pass is fully clean.
 * - Page-fetch / lease-loss errors never advance the watermark.
 *
 * Residual risk: an already-issued Google HTTP request cannot be cancelled if the
 * lease is stolen mid-flight. Checkpoint/AI writes after loss are refused.
 * Reviews that change during pagination may shift pages; the next successful
 * full incremental pass heals gaps when the watermark has not skipped failures.
 */
async function syncLocation(location, fence) {
    const claimed = await claimLocationFence(location, fence);
    if (!claimed) {
        return { ok: false, skipped: true, reason: "location_busy", created: 0, processed: 0 };
    }

    const connection = await loadActiveConnectionForOrg(location.orgId);
    if (!connection || String(connection._id) !== String(location.connectionId)) {
        const message = "Google connection missing or mismatched for location";
        await writeLocationProgress(location, fence, {
            lastSyncError: message,
            syncEnabled: false,
            syncFenceToken: "",
        }).catch(() => {});
        return { ok: false, message: "Location is not linked to an active Google connection", created: 0, processed: 0 };
    }

    if (!location.googleAccountId) {
        const message = "Location is missing googleAccountId required for review sync";
        await writeLocationProgress(location, fence, {
            lastSyncError: message,
            syncFenceToken: "",
        }).catch(() => {});
        return { ok: false, message, created: 0, processed: 0 };
    }

    let accessToken;
    try {
        accessToken = await getValidAccessToken(connection);
    } catch (err) {
        const message = "Failed to obtain Google access token";
        await writeLocationProgress(location, fence, {
            lastSyncError: message,
            syncFenceToken: "",
        }).catch(() => {});
        return { ok: false, message, created: 0, processed: 0 };
    }

    const passWasIncomplete =
        Boolean(claimed.syncPassIncomplete) || Boolean(location.syncPassIncomplete);
    const storedCheckpoint =
        claimed.syncCheckpointPageToken || location.syncCheckpointPageToken || "";
    // Incomplete prior pass ⇒ conservative restart from newest (ignore checkpoint).
    let pageToken = passWasIncomplete ? "" : storedCheckpoint;
    if (passWasIncomplete && storedCheckpoint) {
        await writeLocationProgress(location, fence, {
            syncCheckpointPageToken: "",
            syncPassIncomplete: true,
        });
    }

    const watermark = claimed.syncWatermarkUpdateTime || location.syncWatermarkUpdateTime || "";
    // When recovering a *clean* page checkpoint, do not early-stop on watermark until done.
    const recoveringCheckpoint = Boolean(pageToken) && !passWasIncomplete;
    let created = 0;
    let processed = 0;
    let skippedDuplicates = 0;
    let malformedCount = 0;
    const malformedReasons = Object.create(null);
    let pages = 0;
    let maxUpdateTimeSeen = watermark;
    let stoppedAtWatermark = false;
    let hadProcessingFailure = false;
    // True once this pass has durably recorded incompleteness (crash-safe).
    let incompleteMarkerWritten = false;
    let lastHeartbeat = Date.now();

    async function persistIncompleteMarker() {
        if (incompleteMarkerWritten) return;
        incompleteMarkerWritten = true;
        await writeLocationProgress(location, fence, {
            syncPassIncomplete: true,
            syncCheckpointPageToken: "",
        });
    }

    const passHasIssue = () => hadProcessingFailure || malformedCount > 0;

    try {
        do {
            await assertLease(fence);
            if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
                await assertLease(fence);
                lastHeartbeat = Date.now();
            }

            const page = await listReviews(accessToken, location.googleAccountId, location.googleLocationId, {
                pageToken: pageToken || undefined,
                pageSize: 50,
            });
            // Lease may have been stolen during the HTTP call — refuse further writes.
            await assertLease(fence);
            pages += 1;

            for (const googleReview of page.reviews) {
                await assertLease(fence);

                const updateTime = parseGoogleUpdateTime(googleReview.updateTime);
                if (
                    !recoveringCheckpoint &&
                    watermark &&
                    updateTime &&
                    compareUpdateTime(updateTime, watermark) < 0
                ) {
                    stoppedAtWatermark = true;
                    break;
                }

                const classified = classifyMalformedReview(googleReview);
                if (!classified.ok) {
                    malformedCount += 1;
                    for (const reason of classified.reasons) {
                        malformedReasons[reason] = (malformedReasons[reason] || 0) + 1;
                    }
                    // Conservative: treat as incomplete so watermark cannot advance past
                    // a potentially transient malformed payload.
                    await persistIncompleteMarker();
                    continue;
                }

                const reviewerName =
                    (googleReview.reviewer && typeof googleReview.reviewer.displayName === "string"
                        ? googleReview.reviewer.displayName
                        : "") || "";

                try {
                    const result = await processIncomingReview({
                        location,
                        googleReviewId: classified.googleReviewId,
                        reviewerName,
                        rating: classified.rating,
                        comment: googleReview.comment || "",
                        googleResourceName: classified.resourceName,
                    });
                    processed += 1;
                    if (result.created) created += 1;
                    else skippedDuplicates += 1;
                    if (updateTime && compareUpdateTime(updateTime, maxUpdateTimeSeen) > 0) {
                        maxUpdateTimeSeen = updateTime;
                    }
                } catch (err) {
                    hadProcessingFailure = true;
                    console.error(
                        `Sync failed for review at location ${location._id}:`,
                        err && err.message ? err.message : "unknown"
                    );
                    // Durable before any further page-token progress can be written.
                    await persistIncompleteMarker();
                }

                if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
                    await assertLease(fence);
                    lastHeartbeat = Date.now();
                }
            }

            if (stoppedAtWatermark) {
                pageToken = "";
            } else if (passHasIssue()) {
                // Never checkpoint past a failed/malformed review (closes crash window).
                pageToken = "";
            } else {
                pageToken = page.nextPageToken || "";
            }

            await writeLocationProgress(location, fence, {
                syncCheckpointPageToken: pageToken,
                ...(passHasIssue() ? { syncPassIncomplete: true } : {}),
            });
        } while (pageToken);

        if (malformedCount > 0) {
            logMalformedSummary(location._id, malformedReasons, malformedCount);
        }

        if (passHasIssue()) {
            const parts = [];
            if (hadProcessingFailure) parts.push("processing failure");
            if (malformedCount > 0) {
                parts.push(`malformed payloads (${malformedCount})`);
            }
            const message = `Partial sync incomplete (${parts.join(", ")}); watermark not advanced`;
            await writeLocationProgress(location, fence, {
                lastSyncError: message,
                syncCheckpointPageToken: "",
                syncPassIncomplete: true,
                syncFenceToken: "",
            });
            return {
                ok: false,
                partialFailure: true,
                incomplete: true,
                malformed: malformedCount > 0,
                message,
                created,
                processed,
                skipped: skippedDuplicates,
                skippedDuplicates,
                malformedCount,
                malformedReasons: { ...malformedReasons },
                pages,
                stoppedAtWatermark,
            };
        }

        // Clean pass (including full recovery after a prior incomplete marker).
        const successFields = {
            lastSyncSuccessAt: new Date(),
            lastSyncError: "",
            syncCheckpointPageToken: "",
            syncPassIncomplete: false,
            syncFenceToken: "",
        };
        if (maxUpdateTimeSeen) {
            successFields.syncWatermarkUpdateTime = maxUpdateTimeSeen;
        }

        await writeLocationProgress(location, fence, successFields);

        return {
            ok: true,
            created,
            processed,
            skipped: skippedDuplicates,
            skippedDuplicates,
            malformedCount: 0,
            pages,
            stoppedAtWatermark,
        };
    } catch (err) {
        if (err instanceof StaleLeaseError) {
            // Do not clear the newer owner's fence, incomplete marker, or watermark.
            return {
                ok: false,
                stale: true,
                message: "Sync ownership lost to another worker",
                created,
                processed,
                skipped: skippedDuplicates,
                skippedDuplicates,
                malformedCount,
            };
        }
        const message =
            err instanceof GoogleApiError
                ? "Google API error while syncing reviews"
                : "Review sync failed";
        try {
            await writeLocationProgress(location, fence, {
                lastSyncError: message,
                // Keep pageToken for fetch-level recovery only when this pass had no
                // review-level incompleteness; otherwise keep incomplete + empty token.
                ...(passHasIssue() || incompleteMarkerWritten
                    ? { syncPassIncomplete: true, syncCheckpointPageToken: "" }
                    : {}),
                syncFenceToken: "",
            });
        } catch {
            // ignore stale write failures
        }
        return {
            ok: false,
            message,
            created,
            processed,
            skipped: skippedDuplicates,
            skippedDuplicates,
            malformedCount,
        };
    }
}

function eligibleLocationFilter(extra = {}) {
    return {
        syncEnabled: true,
        connectionId: { $ne: null },
        googleAccountId: { $ne: "" },
        ...extra,
    };
}

/**
 * Synchronize eligible locations for a single organization.
 * Uses a per-org lease so manual and scheduled work for other orgs can proceed.
 */
async function runOrganizationSync(orgId) {
    if (!orgId) {
        return { skipped: true, reason: "missing_org" };
    }
    if (!isOAuthConfigured()) {
        return { skipped: true, reason: "oauth_not_configured" };
    }

    const fence = await acquireLease(orgLeaseKey(orgId));
    if (!fence) {
        return { skipped: true, reason: "org_sync_in_progress" };
    }

    const summary = {
        orgId: String(orgId),
        locations: 0,
        created: 0,
        processed: 0,
        errors: 0,
        skippedUnlinked: 0,
        results: [],
    };

    try {
        const locations = await Location.find(
            eligibleLocationFilter({ orgId })
        );

        // Count unlinked locations for the org without syncing them (no details leaked).
        const unlinkedCount = await Location.countDocuments({
            orgId,
            $or: [
                { connectionId: null },
                { googleAccountId: "" },
                { syncEnabled: false },
            ],
        });
        summary.skippedUnlinked = unlinkedCount;

        for (const location of locations) {
            if (!(await renewLease(fence))) {
                summary.errors += 1;
                summary.results.push({
                    locationId: String(location._id),
                    ok: false,
                    message: "Sync ownership lost",
                });
                break;
            }

            summary.locations += 1;
            try {
                const result = await syncLocation(location, fence);
                summary.created += result.created || 0;
                summary.processed += result.processed || 0;
                if (!result.ok && !result.skipped) summary.errors += 1;
                summary.results.push({
                    locationId: String(location._id),
                    name: location.name,
                    ok: Boolean(result.ok),
                    created: result.created || 0,
                    skipped: Boolean(result.skipped),
                    // Sanitized message only — never include other tenants' data.
                    message: result.message || undefined,
                });
            } catch (err) {
                summary.errors += 1;
                console.error(`Unhandled sync error for location ${location._id}:`, err.message);
                summary.results.push({
                    locationId: String(location._id),
                    ok: false,
                    message: "Sync failed",
                });
            }
        }
    } finally {
        await releaseLease(fence).catch(() => {});
    }

    return summary;
}

/**
 * Scheduled global worker: synchronizes every organization that has eligible locations.
 * Acquires a global cycle lease, then per-org leases via runOrganizationSync.
 */
async function runReviewSyncCycle() {
    if (globalCycleRunning) {
        return { skipped: true, reason: "already_running" };
    }
    if (!isOAuthConfigured()) {
        return { skipped: true, reason: "oauth_not_configured" };
    }

    globalCycleRunning = true;
    const cycleFence = await acquireLease(GLOBAL_LEASE_KEY);
    if (!cycleFence) {
        globalCycleRunning = false;
        return { skipped: true, reason: "lease_held" };
    }

    const summary = { organizations: 0, locations: 0, created: 0, errors: 0, orgSummaries: [] };

    try {
        const orgIds = await Location.distinct(
            "orgId",
            eligibleLocationFilter()
        );

        for (const orgId of orgIds) {
            if (!(await renewLease(cycleFence))) {
                break;
            }
            summary.organizations += 1;
            const orgSummary = await runOrganizationSync(orgId);
            if (orgSummary.skipped) {
                summary.orgSummaries.push({
                    orgId: String(orgId),
                    skipped: true,
                    reason: orgSummary.reason,
                });
                continue;
            }
            summary.locations += orgSummary.locations || 0;
            summary.created += orgSummary.created || 0;
            summary.errors += orgSummary.errors || 0;
            summary.orgSummaries.push({
                orgId: String(orgId),
                locations: orgSummary.locations,
                created: orgSummary.created,
                errors: orgSummary.errors,
            });
        }
    } finally {
        await releaseLease(cycleFence).catch(() => {});
        globalCycleRunning = false;
    }

    return summary;
}

function startReviewSyncScheduler(env = process.env) {
    if (intervalHandle) return intervalHandle;
    if (env.NODE_ENV === "test") return null;
    if (env.DISABLE_REVIEW_SYNC === "true") {
        console.warn("Review sync scheduler disabled (DISABLE_REVIEW_SYNC=true)");
        return null;
    }

    const intervalMs = getSyncIntervalMs(env);
    console.log(`Review sync scheduler started (every ${Math.round(intervalMs / 60000)} minutes)`);

    const initial = setTimeout(() => {
        runReviewSyncCycle().catch((err) => console.error("Initial review sync failed:", err.message));
    }, 15000);
    if (typeof initial.unref === "function") initial.unref();

    intervalHandle = setInterval(() => {
        runReviewSyncCycle().catch((err) => console.error("Scheduled review sync failed:", err.message));
    }, intervalMs);

    if (typeof intervalHandle.unref === "function") {
        intervalHandle.unref();
    }
    return intervalHandle;
}

function stopReviewSyncScheduler() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}

module.exports = {
    getSyncIntervalMs,
    acquireLease,
    renewLease,
    releaseLease,
    assertLease,
    writeLocationProgress,
    syncLocation,
    classifyMalformedReview,
    runOrganizationSync,
    runReviewSyncCycle,
    startReviewSyncScheduler,
    stopReviewSyncScheduler,
    orgLeaseKey,
    GLOBAL_LEASE_KEY,
    LEASE_TTL_MS,
    StaleLeaseError,
    DEFAULT_INTERVAL_MINUTES,
    parseGoogleUpdateTime,
    compareUpdateTime,
};
