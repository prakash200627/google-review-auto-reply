const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
    {
        orgId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Organization",
            required: true,
        },

        locationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Location",
            required: true,
        },

        googleReviewId: {
            type: String,
            required: true,
            unique: true,
        },

        reviewerName: {
            type: String,
            default: "",
        },

        rating: {
            type: Number,
            required: true,
            min: 1,
            max: 5,
        },

        text: {
            type: String,
            default: "",
        },

        status: {
            type: String,
            enum: ["pending", "approved", "replied", "published", "rejected"],
            default: "pending",
        },

        sentiment: {
            type: String,
            enum: ["positive", "negative", "neutral"],
            default: "neutral",
        },
        // Store full Google resource name for reply publishing
        googleResourceName: {
            type: String,
            default: "",
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Review", reviewSchema);