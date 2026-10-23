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

        // Why the reply was routed to human review (e.g. "food_safety").
        riskReasons: {
            type: [String],
            default: [],
        },

        // Set when publishing to Google failed; the reply stays "pending" so it can be retried.
        lastPublishError: {
            type: String,
            default: "",
        },

        // Detail of the latest publish attempt:
        // sending   -> Google API request in flight
        // accepted  -> retained for historical records (Make.com era); unused by direct publish
        // unknown   -> request outcome ambiguous (e.g. timeout); may or may not have published
        // published -> Google returned a successful updateReply response (or reconciled match)
        // failed    -> definitive send error
        publishState: {
            type: String,
            enum: ["none", "sending", "accepted", "unknown", "published", "failed"],
            default: "none",
        },

        // SHA-256 of the current publish attempt ID (raw ID is never stored).
        publishAttemptIdHash: {
            type: String,
            default: null,
            select: false,
        },

        // Hashes of recent attempts (including the current one).
        publishAttemptHashes: {
            type: [String],
            default: [],
            select: false,
        },

        publishRequestedAt: {
            type: Date,
            default: null,
        },

        publishAcceptedAt: {
            type: Date,
            default: null,
        },

        // Capped audit trail of publish events (newest last). `attempt` is the first 12 hex
        // characters of the attempt hash, enough to correlate with publishAttemptHashes.
        publishHistory: {
            type: [
                new mongoose.Schema(
                    {
                        attempt: { type: String, default: "" },
                        event: { type: String, required: true },
                        at: { type: Date, default: Date.now },
                        detail: { type: String, default: "" },
                    },
                    { _id: false }
                ),
            ],
            default: [],
        },
    },
    {
        timestamps: true,
    }
);

replySchema.index({ orgId: 1, status: 1 });

module.exports = mongoose.model("Reply", replySchema);