const express = require("express");
const mongoose = require("mongoose");

const Review = require("../models/Review");
const Reply = require("../models/Reply");
const authMiddleware = require("../middleware/authMiddleware");
const axios = require("axios");

const router = express.Router();

// =========================
// Approve Reply
// =========================

router.post("/approve", authMiddleware, async (req, res) => {
    try {
        const { reviewId, finalReply } = req.body || {};

        if (!reviewId) {
            return res.status(400).json({
                success: false,
                message: "reviewId is required",
            });
        }

        if (!mongoose.isValidObjectId(reviewId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid review ID format",
            });
        }

        const review = await Review.findById(reviewId);

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
                message: "You are not allowed to approve this review",
            });
        }

        const reply = await Reply.findOne({
            reviewId: review._id,
            orgId: req.organizationId,
        });

        if (!reply) {
            return res.status(404).json({
                success: false,
                message: "Reply not found",
            });
        }

        const approvedReply =
            finalReply || reply.draftReply;

        reply.finalReply = approvedReply;
        reply.status = "approved";
        await reply.save();

        // Update review status to reflect replied state
        review.status = "replied";
        await review.save();

        // Send approved reply to Make.com webhook
        const webhookUrl = process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL;
        if (!webhookUrl) {
            console.error("MAKE_APPROVED_REPLY_WEBHOOK_URL not configured");
            return res.status(500).json({
                success: false,
                message: "Make.com webhook URL not configured",
                reply,
            });
        }
        try {
            await axios.post(webhookUrl, {
                reviewId: review._id,
                orgId: review.orgId,
                finalReply: approvedReply,
                googleResourceName: review.googleResourceName,
            });
        } catch (err) {
            console.error("Failed to call Make.com webhook:", err.message);
            // Do not revert approval status, but inform client of webhook failure
            return res.status(502).json({
                success: false,
                message: "Approved but failed to notify Make.com webhook",
                reply,
            });
        }

        res.json({
            success: true,
            message: "Reply approved and webhook notified",
            reply,
        });

    } catch (error) {
        console.error(
            "Approve reply error:",
            error.message
        );

        res.status(500).json({
            success: false,
            message: "Failed to approve reply",
        });
    }
});


// =========================
// Reject Reply
// =========================

router.post("/reject", authMiddleware, async (req, res) => {
    try {
        const { reviewId } = req.body || {};

        if (!reviewId) {
            return res.status(400).json({
                success: false,
                message: "reviewId is required",
            });
        }

        if (!mongoose.isValidObjectId(reviewId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid review ID format",
            });
        }

        // Find review by ID
        const review = await Review.findById(reviewId);

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
                message: "You are not allowed to reject this review",
            });
        }

        const reply = await Reply.findOne({
            reviewId: review._id,
            orgId: req.organizationId,
        });

        if (!reply) {
            return res.status(404).json({
                success: false,
                message: "Reply not found",
            });
        }

        // Reject reply
        reply.status = "rejected";
        await reply.save();

        // Reject review
        review.status = "rejected";
        await review.save();

        return res.json({
            success: true,
            message: "Reply rejected successfully",
            reply,
        });

    } catch (error) {
        console.error(
            "Reject reply error:",
            error.message
        );

        return res.status(500).json({
            success: false,
            message: "Failed to reject reply",
        });
    }
});


module.exports = router;