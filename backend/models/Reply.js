const mongoose = require("mongoose");

const replySchema = new mongoose.Schema(
    {
        reviewId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Review",
            required: true,
            unique: true,
        },

        orgId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Organization",
            required: true,
        },

        draftReply: {
            type: String,
            required: true,
        },

        finalReply: {
            type: String,
            default: "",
        },

        status: {
            type: String,
            enum: ["pending", "approved", "published", "rejected"],
            default: "pending",
        },

        needsHumanReview: {
            type: Boolean,
            default: false,
        },

        urgency: {
            type: String,
            enum: ["low", "medium", "high"],
            default: "low",
        },

        publishedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Reply", replySchema);