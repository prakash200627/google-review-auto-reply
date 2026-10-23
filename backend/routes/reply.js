const express = require("express");
const mongoose = require("mongoose");

const Review = require("../models/Review");
const Reply = require("../models/Reply");
const authMiddleware = require("../middleware/authMiddleware");
const {
    dispatchPublish,
    isPublishConfigured,
    canPublishReview,
    newPublishAttempt,
    attemptStartUpdate,
    historyPush,
    getStaleThresholdMs,
    isPublishAttemptStale,
    inspectGoogleReply,
    IN_FLIGHT_STATES,
} = require("../services/publisher");

const router = express.Router();

const MAX_REPLY_LENGTH = 4096;

async function loadOwnedReviewAndReply(req, res, action) {
    const { reviewId } = req.body || {};

    if (!reviewId) {
        res.status(400).json({ success: false, message: "reviewId is required" });
        return null;
    }

    if (!mongoose.isValidObjectId(reviewId)) {
        res.status(400).json({ success: false, message: "Invalid review ID format" });
        return null;
    }

    const review = await Review.findById(reviewId);

    if (!review) {
        res.status(404).json({ success: false, message: "Review not found" });
        return null;
    }

    if (review.orgId.toString() !== req.organizationId.toString()) {
        res.status(403).json({ success: false, message: `You are not allowed to ${action} this review` });
        return null;
    }

    const reply = await Reply.findOne({
        reviewId: review._id,
        orgId: req.organizationId,
    });

    if (!reply) {
        res.status(404).json({ success: false, message: "Reply not found" });
        return null;
    }

    return { review, reply };
}

function isPending(reply) {
    return (reply.status || "pending") === "pending";
}

function publishNotConfigured(res, reply, message) {
    console.error(message || "Google publishing is not configured");
    return res.status(500).json({
        success: false,
        message: message || "Google Business Profile publishing is not configured",
        reply,
    });
}

function sendDispatchResult(res, result) {
    if (result.outcome === "published") {
        return res.json({
            success: true,
            message: "Reply published to Google Business Profile",
            publishState: "published",
            reply: result.reply,
        });
    }
    if (result.outcome === "accepted") {
        // Retained for historical compatibility; direct Google publish no longer uses this path.
        return res.json({
            success: true,
            message: "Reply accepted for publishing",
            publishState: "accepted",
            reply: result.reply,
        });
    }
    if (result.outcome === "unknown") {
        return res.status(202).json({
            success: true,
            message:
                "Google did not confirm the publish outcome. The reply may still be live; check Google before retrying.",
            publishState: "unknown",
            reply: result.reply,
        });
    }
    return res.status(502).json({
        success: false,
        message: "Failed to publish the reply to Google. It is still pending, so you can retry.",
        publishState: "failed",
        reply: result.reply,
    });
}

router.post("/approve", authMiddleware, async (req, res) => {
    try {
        const { finalReply } = req.body || {};

        if (finalReply !== undefined && finalReply !== null && typeof finalReply !== "string") {
            return res.status(400).json({ success: false, message: "finalReply must be a string" });
        }
        if (typeof finalReply === "string" && finalReply.trim().length > MAX_REPLY_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `finalReply must be at most ${MAX_REPLY_LENGTH} characters`,
            });
        }

        const loaded = await loadOwnedReviewAndReply(req, res, "approve");
        if (!loaded) return;
        const { review, reply } = loaded;

        if (!isPending(reply)) {
            return res.status(409).json({
                success: false,
                message: `Reply has already been ${reply.status}`,
                reply,
            });
        }

        if (!isPublishConfigured()) {
            return publishNotConfigured(res, reply, "Google OAuth is not configured on the server");
        }

        const publishCheck = await canPublishReview(review);
        if (!publishCheck.ok) {
            return publishNotConfigured(res, reply, publishCheck.message);
        }

        const approvedReply = (typeof finalReply === "string" && finalReply.trim()) || reply.draftReply;
        const attempt = newPublishAttempt();

        const claimed = await Reply.findOneAndUpdate(
            { _id: reply._id, orgId: req.organizationId, status: "pending" },
            attemptStartUpdate(attempt, { status: "approved", finalReply: approvedReply }),
            { returnDocument: "after" }
        );

        if (!claimed) {
            return res.status(409).json({
                success: false,
                message: "Reply is already being processed",
            });
        }

        review.status = "approved";
        await review.save();

        const result = await dispatchPublish({ review, replyId: reply._id, finalReply: approvedReply, attempt });
        return sendDispatchResult(res, result);
    } catch (error) {
        console.error("Approve reply error:", error.message);
        res.status(500).json({
            success: false,
            message: "Failed to approve reply",
        });
    }
});

router.post("/retry-publish", authMiddleware, async (req, res) => {
    try {
        const loaded = await loadOwnedReviewAndReply(req, res, "publish");
        if (!loaded) return;
        const { review, reply } = loaded;

        if (reply.status !== "approved" || reply.publishState !== "unknown") {
            return res.status(409).json({
                success: false,
                message: "Only replies whose publish status is unknown can be retried",
                reply,
            });
        }

        if (!isPublishConfigured()) {
            return publishNotConfigured(res, reply, "Google OAuth is not configured on the server");
        }

        const publishCheck = await canPublishReview(review);
        if (!publishCheck.ok) {
            return publishNotConfigured(res, reply, publishCheck.message);
        }

        const attempt = newPublishAttempt();
        const claimed = await Reply.findOneAndUpdate(
            { _id: reply._id, orgId: req.organizationId, status: "approved", publishState: "unknown" },
            attemptStartUpdate(attempt),
            { returnDocument: "after" }
        );

        if (!claimed) {
            return res.status(409).json({
                success: false,
                message: "Reply is already being processed",
            });
        }

        const finalReplyText = claimed.finalReply || reply.finalReply || reply.draftReply;
        const result = await dispatchPublish({ review, replyId: reply._id, finalReply: finalReplyText, attempt });
        return sendDispatchResult(res, result);
    } catch (error) {
        console.error("Retry publish error:", error.message);
        return res.status(500).json({ success: false, message: "Failed to retry publishing" });
    }
});

router.post("/reconcile-publish", authMiddleware, async (req, res) => {
    try {
        const loaded = await loadOwnedReviewAndReply(req, res, "reconcile");
        if (!loaded) return;
        const { review, reply } = loaded;

        if (reply.status !== "approved" || !IN_FLIGHT_STATES.includes(reply.publishState)) {
            return res.status(409).json({
                success: false,
                message: "Only replies waiting for publish confirmation can be reconciled",
                reply,
            });
        }

        const thresholdMs = getStaleThresholdMs();
        if (!isPublishAttemptStale(reply)) {
            const staleAt = new Date(new Date(reply.publishRequestedAt).getTime() + thresholdMs);
            return res.status(409).json({
                success: false,
                message: `This attempt is not stale yet. Wait until ${staleAt.toISOString()} for Google to confirm.`,
                staleAt,
                reply,
            });
        }

        // Prefer authoritative Google state when available.
        const inspection = await inspectGoogleReply(review);
        if (inspection && inspection.matched) {
            const expected = (reply.finalReply || reply.draftReply || "").trim();
            const remote = (inspection.googleReplyComment || "").trim();
            if (expected && remote && expected === remote) {
                const confirmed = await Reply.findOneAndUpdate(
                    {
                        _id: reply._id,
                        orgId: req.organizationId,
                        status: "approved",
                        publishState: { $in: IN_FLIGHT_STATES },
                    },
                    {
                        $set: {
                            status: "published",
                            publishState: "published",
                            publishedAt: new Date(),
                            lastPublishError: "",
                        },
                        $push: historyPush(null, "reconciled_published_from_google"),
                    },
                    { returnDocument: "after" }
                );
                if (confirmed) {
                    await Review.updateOne(
                        { _id: review._id, orgId: req.organizationId },
                        { $set: { status: "published" } }
                    );
                    return res.json({
                        success: true,
                        publishState: "published",
                        message: "Google already has this reply. Marked as published.",
                        reply: confirmed,
                    });
                }
            }
        }

        const minutes = Math.round(thresholdMs / 60000);
        const previousState = reply.publishState;
        const cutoff = new Date(Date.now() - thresholdMs);
        const message =
            `No confirmation from Google within ${minutes} minutes (last state: ${previousState}). ` +
            "The reply may or may not be live on Google.";

        const reconciled = await Reply.findOneAndUpdate(
            {
                _id: reply._id,
                orgId: req.organizationId,
                status: "approved",
                publishState: { $in: IN_FLIGHT_STATES },
                $or: [{ publishRequestedAt: { $lte: cutoff } }, { publishRequestedAt: null }],
            },
            {
                $set: { publishState: "unknown", lastPublishError: message },
                $push: historyPush(null, "marked_unknown_stale", `previous state: ${previousState}`),
            },
            { returnDocument: "after" }
        );

        if (!reconciled) {
            return res.status(409).json({
                success: false,
                message: "The publish attempt changed while reconciling. Refresh to see its current state.",
            });
        }

        return res.json({
            success: true,
            publishState: "unknown",
            message:
                `${message} Check the review on Google. Retrying sends the reply again and replaces ` +
                "any reply that was already published.",
            reply: reconciled,
        });
    } catch (error) {
        console.error("Reconcile publish error:", error.message);
        return res.status(500).json({ success: false, message: "Failed to reconcile publish attempt" });
    }
});

router.post("/reject", authMiddleware, async (req, res) => {
    try {
        const loaded = await loadOwnedReviewAndReply(req, res, "reject");
        if (!loaded) return;
        const { review, reply } = loaded;

        if (!isPending(reply)) {
            return res.status(409).json({
                success: false,
                message: `Reply has already been ${reply.status}`,
                reply,
            });
        }

        const rejected = await Reply.findOneAndUpdate(
            { _id: reply._id, orgId: req.organizationId, status: "pending" },
            { $set: { status: "rejected" } },
            { returnDocument: "after" }
        );

        if (!rejected) {
            return res.status(409).json({
                success: false,
                message: "Reply is already being processed",
            });
        }

        review.status = "rejected";
        await review.save();

        return res.json({
            success: true,
            message: "Reply rejected successfully",
            reply: rejected,
        });
    } catch (error) {
        console.error("Reject reply error:", error.message);
        return res.status(500).json({
            success: false,
            message: "Failed to reject reply",
        });
    }
});

module.exports = router;
