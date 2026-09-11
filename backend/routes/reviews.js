const express = require("express");
const mongoose = require("mongoose");

const Review = require("../models/Review");
const Reply = require("../models/Reply");
const Location = require("../models/Location");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();


// GET all reviews for logged-in organization
router.get("/", authMiddleware, async (req, res) => {
    try {
        const reviews = await Review.find({
            orgId: req.organizationId,
        })
            .populate("locationId", "name googleLocationId")
            .sort({ createdAt: -1 });

        const reviewData = await Promise.all(
            reviews.map(async (review) => {
                const reply = await Reply.findOne({
                    reviewId: review._id,
                    orgId: req.organizationId,
                });

                return {
                    ...review.toObject(),
                    reply,
                };
            })
        );

        res.json({
            success: true,
            reviews: reviewData,
        });
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
        const reviews = await Review.find({
            orgId: req.organizationId,
            status: "pending",
        })
            .populate("locationId", "name googleLocationId")
            .sort({ createdAt: -1 });

        const reviewData = await Promise.all(
            reviews.map(async (review) => {
                const reply = await Reply.findOne({
                    reviewId: review._id,
                    orgId: req.organizationId,
                });

                return {
                    ...review.toObject(),
                    reply,
                };
            })
        );

        res.json({
            success: true,
            reviews: reviewData,
        });
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
                reply,
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