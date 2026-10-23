const mongoose = require("mongoose");

// Coordinates review-sync workers across backend instances.
// ownerId is a unique token per acquisition (fencing token). Renew/release
// only succeed when ownerId still matches.
const syncLeaseSchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
        },

        ownerId: {
            type: String,
            required: true,
        },

        // Monotonic generation bumped on every successful acquisition/takeover.
        generation: {
            type: Number,
            required: true,
            default: 1,
        },

        lockedUntil: {
            type: Date,
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("SyncLease", syncLeaseSchema);
