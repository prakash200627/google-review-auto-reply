const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
    {
        orgId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Organization",
            required: true,
        },

        name: {
            type: String,
            required: true,
        },

        // Numeric/string ID segment from Google (locations/{id}).
        googleLocationId: {
            type: String,
            required: true,
        },

        // Account ID segment (accounts/{id}) required by the Reviews v4 API.
        googleAccountId: {
            type: String,
            default: "",
        },

        connectionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "GoogleConnection",
            default: null,
        },

        syncEnabled: {
            type: Boolean,
            default: true,
        },

        lastSyncAttemptAt: {
            type: Date,
            default: null,
        },

        lastSyncSuccessAt: {
            type: Date,
            default: null,
        },

        lastSyncError: {
            type: String,
            default: "",
        },

        // In-progress pagination token; cleared when a sync pass completes.
        // Never advanced to a later page after a processing/malformed failure —
        // see syncPassIncomplete.
        syncCheckpointPageToken: {
            type: String,
            default: "",
        },

        // Highest Google review updateTime fully processed (ISO-8601). Used to
        // stop early on subsequent syncs. Advanced only after a fully successful
        // pass (no processing failures and no malformed payloads).
        syncWatermarkUpdateTime: {
            type: String,
            default: "",
        },

        // Durable marker: prior pass had review-processing or malformed-payload
        // issues (or crashed before cleanup). While true, sync ignores any
        // leftover page-token checkpoint and will not advance the watermark
        // until a complete clean pass finishes. Cleared only on success.
        syncPassIncomplete: {
            type: Boolean,
            default: false,
        },

        // Fencing token of the worker currently allowed to write sync progress.
        syncFenceToken: {
            type: String,
            default: "",
        },
    },
    {
        timestamps: true,
    }
);

locationSchema.index({ googleLocationId: 1 });
locationSchema.index({ orgId: 1 });
locationSchema.index({ connectionId: 1 });
locationSchema.index({ syncEnabled: 1, lastSyncAttemptAt: 1 });
locationSchema.index({ orgId: 1, syncEnabled: 1, connectionId: 1 });

module.exports = mongoose.model("Location", locationSchema);
