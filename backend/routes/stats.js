const express = require("express");
const mongoose = require("mongoose");

const Review = require("../models/Review");
const Reply = require("../models/Reply");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// GET /api/stats - Dashboard statistics for logged-in organization
router.get("/", authMiddleware, async (req, res) => {
    try {
        const orgObjectId = new mongoose.Types.ObjectId(req.organizationId);

        const [reviewStats, replyStats] = await Promise.all([
            Review.aggregate([
                { $match: { orgId: orgObjectId } },
                {
                    $group: {
                        _id: null,
                        totalReviews: { $sum: 1 },
                        pendingReviews: {
                            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] }
                        },
                        repliedReviews: {
                            $sum: { $cond: [{ $in: ["$status", ["approved", "replied", "published"]] }, 1, 0] }
                        },
                        rejectedReviews: {
                            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] }
                        },
                        positiveReviews: {
                            $sum: { $cond: [{ $eq: ["$sentiment", "positive"] }, 1, 0] }
                        },
                        negativeReviews: {
                            $sum: { $cond: [{ $eq: ["$sentiment", "negative"] }, 1, 0] }
                        },
                        neutralReviews: {
                            $sum: { $cond: [{ $eq: ["$sentiment", "neutral"] }, 1, 0] }
                        }
                    }
                }
            ]),
            Reply.aggregate([
                { $match: { orgId: orgObjectId } },
                {
                    $group: {
                        _id: null,
                        totalReplies: { $sum: 1 },
                        approvedReplies: {
                            $sum: { $cond: [{ $in: ["$status", ["approved", "published"]] }, 1, 0] }
                        },
                        rejectedReplies: {
                            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] }
                        },
                        publishedReplies: {
                            $sum: { $cond: [{ $eq: ["$status", "published"] }, 1, 0] }
                        }
                    }
                }
            ])
        ]);

        const rStats = reviewStats[0] || {};
        const repStats = replyStats[0] || {};

        res.json({
            success: true,
            stats: {
                totalReviews: rStats.totalReviews || 0,
                pendingReviews: rStats.pendingReviews || 0,
                repliedReviews: rStats.repliedReviews || 0,
                rejectedReviews: rStats.rejectedReviews || 0,
                positiveReviews: rStats.positiveReviews || 0,
                negativeReviews: rStats.negativeReviews || 0,
                neutralReviews: rStats.neutralReviews || 0,
                totalReplies: repStats.totalReplies || 0,
                approvedReplies: repStats.approvedReplies || 0,
                rejectedReplies: repStats.rejectedReplies || 0,
                publishedReplies: repStats.publishedReplies || 0
            }
        });
    } catch (error) {
        console.error("Get stats error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to get stats"
        });
    }
});

const { generateAnalysis } = require("../services/ai");

// GET /api/stats/analysis - AI analysis for logged-in organization
router.get("/analysis", authMiddleware, async (req, res) => {
    try {
        const result = await generateAnalysis(req.organizationId);
        res.json({
            success: true,
            analysis: result.summary,
            usedOpenAI: result.usedOpenAI,
        });
    } catch (error) {
        console.error("Get stats analysis error:", error.message);
        res.status(500).json({
            success: false,
            message: "Failed to generate AI analysis",
        });
    }
});

module.exports = router;

