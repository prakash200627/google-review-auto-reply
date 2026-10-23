const express = require("express");
const mongoose = require("mongoose");

const Review = require("../models/Review");
const Reply = require("../models/Reply");
const authMiddleware = require("../middleware/authMiddleware");
const { isPublishAttemptStale } = require("../services/publisher");

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 10000;
const MAX_SEARCH_LENGTH = 100;
// Must match the enums in models/Review.js.
const REVIEW_STATUSES = ["pending", "approved", "replied", "published", "rejected"];
const SENTIMENTS = ["positive", "negative", "neutral"];

class QueryValidationError extends Error {}

function parseBoundedInt(value, name, min, max) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new QueryValidationError(`${name} must be an integer between ${min} and ${max}`);
    }
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
        throw new QueryValidationError(`${name} must be an integer between ${min} and ${max}`);
    }
    return parsed;
}

function parseEnum(value, name, allowed) {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new QueryValidationError(`${name} must be one of: ${allowed.join(", ")}`);
    }
    return value;
}

// Adds the server-computed publishStale flag (the threshold is server configuration).
function withPublishStatus(reply) {
    if (!reply) return null;
    const plain = typeof reply.toObject === "function" ? reply.toObject() : { ...reply };
    return { ...plain, publishStale: isPublishAttemptStale(plain) };
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pagination is opt-in (?page=&limit=) so existing clients still receive every review.
function parsePagination(query) {
    if (query.page === undefined && query.limit === undefined) return null;
    const page = query.page === undefined ? 1 : parseBoundedInt(query.page, "page", 1, MAX_PAGE);
    const limit = query.limit === undefined
        ? DEFAULT_PAGE_SIZE
        : parseBoundedInt(query.limit, "limit", 1, MAX_PAGE_SIZE);
    return { page, limit, skip: (page - 1) * limit };
}

// Optional filters; the caller's organization is always applied by the route.
function parseFilters(query, { allowStatus }) {
    const filter = {};
    if (query.status !== undefined) {
        if (!allowStatus) throw new QueryValidationError("status filter is not supported on this endpoint");
        filter.status = parseEnum(query.status, "status", REVIEW_STATUSES);
    }
    if (query.sentiment !== undefined) {
        filter.sentiment = parseEnum(query.sentiment, "sentiment", SENTIMENTS);
    }
    if (query.rating !== undefined) {
        filter.rating = parseBoundedInt(query.rating, "rating", 1, 5);
    }
    if (query.locationId !== undefined) {
        if (typeof query.locationId !== "string" || !mongoose.isValidObjectId(query.locationId)) {
            throw new QueryValidationError("locationId must be a valid ID");
        }
        filter.locationId = query.locationId;
    }
    if (query.search !== undefined) {
        if (typeof query.search !== "string" || query.search.length > MAX_SEARCH_LENGTH) {
            throw new QueryValidationError(`search must be a string of at most ${MAX_SEARCH_LENGTH} characters`);
        }
        const term = query.search.trim();
        if (term) {
            const pattern = new RegExp(escapeRegex(term), "i");
            filter.$or = [{ reviewerName: pattern }, { text: pattern }];
        }
    }
    return filter;
}

async function listReviewsWithReplies(req, res, baseFilter, { allowStatus }) {
    const query = req.query || {};
    let pagination;
    let filter;
    try {
        pagination = parsePagination(query);
        filter = { ...parseFilters(query, { allowStatus }), ...baseFilter };
    } catch (err) {
        if (err instanceof QueryValidationError) {
            return res.status(400).json({ success: false, message: err.message });
        }
        throw err;
    }
    return sendReviewPage(req, res, filter, pagination);
}

async function sendReviewPage(req, res, filter, pagination) {
    let query = Review.find(filter)
        .populate("locationId", "name googleLocationId")
        .sort({ createdAt: -1, _id: -1 });
    if (pagination) query = query.skip(pagination.skip).limit(pagination.limit);

    const [reviews, total] = await Promise.all([
        query,
        pagination ? Review.countDocuments(filter) : Promise.resolve(null),
    ]);

    const replies = reviews.length
        ? await Reply.find({
            orgId: req.organizationId,
            reviewId: { $in: reviews.map((r) => r._id) },
        })
        : [];
    const replyByReviewId = new Map(replies.map((reply) => [reply.reviewId.toString(), reply]));

    const body = {
        success: true,
        reviews: reviews.map((review) => ({
            ...review.toObject(),
            reply: withPublishStatus(replyByReviewId.get(review._id.toString())),
        })),
    };

    if (pagination) {
        const totalPages = Math.ceil(total / pagination.limit);
        body.pagination = {
            page: pagination.page,
            limit: pagination.limit,
            total,
            totalPages,
            hasNextPage: pagination.page < totalPages,
            hasPrevPage: pagination.page > 1,
        };
    }

    res.json(body);
}

// GET all reviews for logged-in organization
router.get("/", authMiddleware, async (req, res) => {
    try {
        await listReviewsWithReplies(req, res, { orgId: req.organizationId }, { allowStatus: true });
    } catch (error) {
        console.error("Get reviews error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to get reviews",
        });
    }
});


// GET pending reviews
router.get("/pending", authMiddleware, async (req, res) => {
    try {
        await listReviewsWithReplies(
            req,
            res,
            { orgId: req.organizationId, status: "pending" },
            { allowStatus: false }
        );
    } catch (error) {
        console.error("Get pending reviews error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to get pending reviews",
        });
    }
});


// GET single review
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid review ID format",
            });
        }

        const review = await Review.findById(req.params.id)
            .populate("locationId", "name googleLocationId");

        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review not found",
            });
        }

        // Security check: review must belong to logged-in organization
        if (review.orgId.toString() !== req.organizationId.toString()) {
            return res.status(403).json({
                success: false,
                message: "You are not allowed to access this review",
            });
        }

        const reply = await Reply.findOne({
            reviewId: review._id,
            orgId: req.organizationId,
        });

        res.json({
            success: true,
            review: {
                ...review.toObject(),
                reply: withPublishStatus(reply),
            },
        });
    } catch (error) {
        console.error("Get review error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to get review",
        });
    }
});


module.exports = router;
