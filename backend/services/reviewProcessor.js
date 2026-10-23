const Review = require("../models/Review");
const Reply = require("../models/Reply");
const Organization = require("../models/Organization");
const generateReply = require("./ai");
const {
    dispatchPublish,
    canPublishReview,
    newPublishAttempt,
    attemptStartUpdate,
} = require("./publisher");

const MAX_COMMENT_LENGTH = 5000;
const MAX_NAME_LENGTH = 200;

function isDuplicateKeyError(err) {
    return Boolean(err && err.code === 11000);
}

async function ensureReplyForExistingReview(existingReview) {
    let existingReply = await Reply.findOne({ reviewId: existingReview._id });

    // A previous sync stored the review but failed before its reply was saved.
    // Recreate the draft for human review; never auto-publish on a retry.
    if (!existingReply) {
        const aiResult = await generateReply(
            {
                rating: existingReview.rating,
                comment: existingReview.text,
                reviewerName: existingReview.reviewerName,
            },
            existingReview.orgId
        );
        try {
            existingReply = await Reply.create({
                reviewId: existingReview._id,
                orgId: existingReview.orgId,
                draftReply: aiResult.draftReply,
                needsHumanReview: aiResult.needsHumanReview,
                urgency: aiResult.urgency,
                riskReasons: aiResult.riskReasons,
                status: "pending",
            });
        } catch (err) {
            if (!isDuplicateKeyError(err)) throw err;
            existingReply = await Reply.findOne({ reviewId: existingReview._id });
        }
    }

    return existingReply;
}

/**
 * Idempotently ingest a review for a known Location document.
 * Used by the Google sync worker (replaces Make.com webhook ingestion).
 *
 * @returns {{ created: boolean, review, reply, autoProcessed: boolean, publishState?: string }}
 */
async function processIncomingReview({
    location,
    googleReviewId,
    reviewerName,
    rating,
    comment,
    googleResourceName,
}) {
    if (!location || !location.orgId) {
        throw Object.assign(new Error("Location is required"), { status: 400 });
    }
    if (!googleReviewId || typeof googleReviewId !== "string") {
        throw Object.assign(new Error("googleReviewId is required"), { status: 400 });
    }
    if (!googleResourceName || typeof googleResourceName !== "string") {
        throw Object.assign(new Error("googleResourceName is required"), { status: 400 });
    }

    const numericRating =
        typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5
            ? rating
            : null;
    if (!numericRating) {
        throw Object.assign(new Error("Invalid Google star rating"), { status: 400 });
    }

    const safeComment = String(comment || "").slice(0, MAX_COMMENT_LENGTH);
    const safeReviewerName = String(reviewerName || "").trim().slice(0, MAX_NAME_LENGTH);

    const existingReview = await Review.findOne({ googleReviewId });
    if (existingReview) {
        // Tenant isolation: never attach a duplicate ID from another org.
        if (String(existingReview.orgId) !== String(location.orgId)) {
            throw Object.assign(new Error("Review ID conflicts with another organization"), { status: 409 });
        }
        let changed = false;
        if (safeReviewerName && !existingReview.reviewerName) {
            existingReview.reviewerName = safeReviewerName;
            changed = true;
        }
        if (googleResourceName && !existingReview.googleResourceName) {
            existingReview.googleResourceName = googleResourceName;
            changed = true;
        }
        if (changed) await existingReview.save();

        const reply = await ensureReplyForExistingReview(existingReview);
        return {
            created: false,
            review: existingReview,
            reply,
            autoProcessed: false,
        };
    }

    const aiResult = await generateReply(
        {
            rating: numericRating,
            comment: safeComment,
            reviewerName: safeReviewerName,
            reviewId: googleReviewId,
        },
        location.orgId
    );

    let review;
    try {
        review = await Review.create({
            orgId: location.orgId,
            locationId: location._id,
            googleReviewId,
            reviewerName: safeReviewerName,
            rating: numericRating,
            text: safeComment,
            sentiment: aiResult.sentiment,
            status: "pending",
            googleResourceName,
        });
    } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const raced = await Review.findOne({ googleReviewId });
        if (!raced) throw err;
        if (String(raced.orgId) !== String(location.orgId)) {
            throw Object.assign(new Error("Review ID conflicts with another organization"), { status: 409 });
        }
        const reply = await ensureReplyForExistingReview(raced);
        return { created: false, review: raced, reply, autoProcessed: false };
    }

    const reply = await Reply.create({
        reviewId: review._id,
        orgId: location.orgId,
        draftReply: aiResult.draftReply,
        needsHumanReview: aiResult.needsHumanReview,
        urgency: aiResult.urgency,
        riskReasons: aiResult.riskReasons,
        status: "pending",
    });

    const organization = await Organization.findById(location.orgId);
    const isAuto = organization && organization.mode === "auto";

    if (isAuto && !aiResult.needsHumanReview) {
        const publishCheck = await canPublishReview(review);
        if (!publishCheck.ok) {
            reply.lastPublishError = publishCheck.message;
            await reply.save();
            return {
                created: true,
                review,
                reply,
                autoProcessed: false,
                publishState: "none",
            };
        }

        const finalReply = aiResult.draftReply;
        const attempt = newPublishAttempt();
        const { $set: attemptFields, $push: attemptPush } = attemptStartUpdate(attempt);
        Object.assign(reply, attemptFields, {
            finalReply,
            status: "approved",
            publishAttemptHashes: [attempt.hash],
            publishHistory: attemptPush.publishHistory.$each,
        });
        await reply.save();
        review.status = "approved";
        await review.save();

        const result = await dispatchPublish({ review, replyId: reply._id, finalReply, attempt });
        return {
            created: true,
            review,
            reply: result.reply || reply,
            autoProcessed: result.outcome === "published" || result.outcome === "accepted",
            publishState: result.outcome,
        };
    }

    return {
        created: true,
        review,
        reply,
        autoProcessed: false,
    };
}

module.exports = {
    processIncomingReview,
    ensureReplyForExistingReview,
    MAX_COMMENT_LENGTH,
    MAX_NAME_LENGTH,
};
