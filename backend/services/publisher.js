const crypto = require("crypto");

const Reply = require("../models/Reply");
const Location = require("../models/Location");
const {
    getValidAccessToken,
    loadActiveConnectionForOrg,
    isOAuthConfigured,
    GoogleOAuthError,
} = require("./googleOAuth");
const { updateReviewReply, getReview, GoogleApiError } = require("./googleBusinessApi");

const PUBLISH_TIMEOUT_MS = 15000;
const MAX_ATTEMPT_HISTORY = 20;
const MAX_PUBLISH_EVENTS = 50;
const DEFAULT_STALE_MINUTES = 15;
const MAX_STALE_MINUTES = 24 * 60;
const IN_FLIGHT_STATES = ["sending", "accepted"];

// Errors that mean the request never reached Google's write path.
const DEFINITIVE_NETWORK_CODES = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ERR_INVALID_URL",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
]);

class PublishNotConfiguredError extends Error {
    constructor(message = "Google Business Profile publishing is not configured") {
        super(message);
        this.name = "PublishNotConfiguredError";
    }
}

function isPublishConfigured() {
    return isOAuthConfigured();
}

function hashAttemptId(attemptId) {
    return crypto.createHash("sha256").update(String(attemptId)).digest("hex");
}

function newPublishAttempt() {
    const id = crypto.randomBytes(32).toString("base64url");
    return { id, hash: hashAttemptId(id) };
}

function getStaleThresholdMs(env = process.env) {
    const raw = (env.PUBLISH_STALE_AFTER_MINUTES || "").trim();
    const minutes = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const valid = minutes >= 1 && minutes <= MAX_STALE_MINUTES;
    return (valid ? minutes : DEFAULT_STALE_MINUTES) * 60 * 1000;
}

function isPublishAttemptStale(reply, now = Date.now()) {
    if (!reply || reply.status !== "approved" || !IN_FLIGHT_STATES.includes(reply.publishState)) return false;
    const startedAt = reply.publishRequestedAt ? new Date(reply.publishRequestedAt).getTime() : NaN;
    if (!Number.isFinite(startedAt)) return true;
    return now - startedAt >= getStaleThresholdMs();
}

function publishEvent(attemptHash, event, detail = "") {
    return {
        attempt: attemptHash ? String(attemptHash).slice(0, 12) : "",
        event,
        at: new Date(),
        detail: String(detail || "").slice(0, 300),
    };
}

function historyPush(attemptHash, event, detail) {
    return { publishHistory: { $each: [publishEvent(attemptHash, event, detail)], $slice: -MAX_PUBLISH_EVENTS } };
}

function attemptStartUpdate(attempt, extraSet = {}) {
    return {
        $set: {
            ...extraSet,
            publishState: "sending",
            publishAttemptIdHash: attempt.hash,
            publishRequestedAt: new Date(),
            publishAcceptedAt: null,
            lastPublishError: "",
        },
        $push: {
            publishAttemptHashes: { $each: [attempt.hash], $slice: -MAX_ATTEMPT_HISTORY },
            ...historyPush(attempt.hash, "attempt_started"),
        },
    };
}

async function canPublishReview(review) {
    if (!isOAuthConfigured()) {
        return { ok: false, message: "Google OAuth is not configured on the server" };
    }
    if (!review || !review.orgId) {
        return { ok: false, message: "Review is missing organization" };
    }
    if (!review.googleResourceName || !String(review.googleResourceName).includes("/reviews/")) {
        return { ok: false, message: "Review is missing a Google resource name" };
    }

    const location = await Location.findOne({ _id: review.locationId, orgId: review.orgId });
    if (!location) {
        return { ok: false, message: "Review location was not found for this organization" };
    }
    if (!location.connectionId) {
        return { ok: false, message: "Location is not linked to a Google connection" };
    }

    const connection = await loadActiveConnectionForOrg(review.orgId);
    if (!connection || String(connection._id) !== String(location.connectionId)) {
        return { ok: false, message: "Google account is disconnected or unauthorized for this location" };
    }
    if (connection.status === "revoked") {
        return { ok: false, message: "Google access was revoked. Reconnect the Google account." };
    }

    return { ok: true, location, connection };
}

function classifyPublishError(err) {
    if (err instanceof PublishNotConfiguredError) {
        return { outcome: "failed", message: err.message };
    }
    if (err instanceof GoogleOAuthError) {
        return { outcome: "failed", message: err.message };
    }
    if (err instanceof GoogleApiError) {
        if (err.code === "timeout") {
            return {
                outcome: "unknown",
                message: "Google API timed out; the reply may still be published",
            };
        }
        if (err.code === "unauthorized" || err.code === "forbidden" || err.code === "revoked") {
            return { outcome: "failed", message: err.message };
        }
        if (err.code === "not_found") {
            return { outcome: "failed", message: "Google review was not found or is no longer available" };
        }
        if (err.retryable) {
            return { outcome: "failed", message: `Google API temporary error: ${err.message}` };
        }
        return { outcome: "failed", message: err.message };
    }
    if (err && err.response && err.response.status) {
        return { outcome: "failed", message: `Google API responded with status ${err.response.status}` };
    }
    const code = err && err.code;
    if (!code) {
        return { outcome: "failed", message: "Google publish request failed" };
    }
    if (DEFINITIVE_NETWORK_CODES.has(code)) {
        return { outcome: "failed", message: `Google API unreachable (${code})` };
    }
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
        return { outcome: "unknown", message: "Google API timed out; the reply may still be published" };
    }
    return {
        outcome: "unknown",
        message: `Google connection interrupted (${code}); the reply may still be published`,
    };
}

function describePublishError(err) {
    return classifyPublishError(err).message;
}

async function publishReplyToGoogle(review, finalReply) {
    const check = await canPublishReview(review);
    if (!check.ok) {
        throw new PublishNotConfiguredError(check.message);
    }

    const accessToken = await getValidAccessToken(check.connection);
    const comment = String(finalReply || "").slice(0, 4096);

    // Race against a hard timeout so ambiguous hangs become "unknown".
    let timer;
    try {
        return await Promise.race([
            updateReviewReply(accessToken, review.googleResourceName, comment),
            new Promise((_, reject) => {
                const err = new GoogleApiError("Google API timed out", {
                    status: 504,
                    code: "timeout",
                    retryable: false,
                });
                timer = setTimeout(() => reject(err), PUBLISH_TIMEOUT_MS);
                if (typeof timer.unref === "function") timer.unref();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Publishes an approved reply via the Google Business Profile API.
 * Success → publishState "published" (authoritative Google response).
 * Ambiguous timeout → "unknown". Definitive errors → "failed" + pending.
 */
async function dispatchPublish({ review, replyId, finalReply, attempt }) {
    const inFlight = { _id: replyId, publishAttemptIdHash: attempt.hash, publishState: "sending" };
    const after = { returnDocument: "after" };

    try {
        await publishReplyToGoogle(review, finalReply);
    } catch (err) {
        const { outcome, message } = classifyPublishError(err);
        console.error(`Google publish request ${outcome} for reply ${replyId}: ${message}`);

        if (outcome === "failed") {
            const reverted = await Reply.findOneAndUpdate(
                inFlight,
                {
                    $set: { status: "pending", publishState: "failed", lastPublishError: message },
                    $push: historyPush(attempt.hash, "send_failed", message),
                },
                after
            );
            if (reverted) {
                review.status = "pending";
                await review.save();
            }
            return { outcome, message, reply: reverted || (await Reply.findById(replyId)) };
        }

        const ambiguous = await Reply.findOneAndUpdate(
            inFlight,
            {
                $set: { publishState: "unknown", lastPublishError: message },
                $push: historyPush(attempt.hash, "send_unknown", message),
            },
            after
        );
        return { outcome, message, reply: ambiguous || (await Reply.findById(replyId)) };
    }

    const published = await Reply.findOneAndUpdate(
        inFlight,
        {
            $set: {
                status: "published",
                publishState: "published",
                publishedAt: new Date(),
                publishAcceptedAt: new Date(),
                lastPublishError: "",
            },
            $push: historyPush(attempt.hash, "published_by_google"),
        },
        after
    );

    if (published) {
        review.status = "published";
        await review.save();
    }

    return {
        outcome: "published",
        message: "",
        reply: published || (await Reply.findById(replyId)),
    };
}

/**
 * Best-effort reconciliation: read the review from Google and see if a reply exists.
 * Returns { matched: boolean, googleReplyComment?: string } or null if lookup failed.
 */
async function inspectGoogleReply(review) {
    try {
        const check = await canPublishReview(review);
        if (!check.ok) return null;
        const accessToken = await getValidAccessToken(check.connection);
        const remote = await getReview(accessToken, review.googleResourceName);
        const replyComment = remote && remote.reviewReply && remote.reviewReply.comment;
        if (typeof replyComment !== "string") {
            return { matched: false, googleReplyComment: "" };
        }
        return { matched: true, googleReplyComment: replyComment };
    } catch {
        return null;
    }
}

module.exports = {
    publishReplyToGoogle,
    dispatchPublish,
    isPublishConfigured,
    canPublishReview,
    classifyPublishError,
    describePublishError,
    hashAttemptId,
    newPublishAttempt,
    attemptStartUpdate,
    historyPush,
    getStaleThresholdMs,
    isPublishAttemptStale,
    inspectGoogleReply,
    IN_FLIGHT_STATES,
    PublishNotConfiguredError,
};
