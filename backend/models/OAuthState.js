const mongoose = require("mongoose");

// Short-lived OAuth state + PKCE verifier. Documents expire via TTL index.
const oauthStateSchema = new mongoose.Schema(
    {
        state: {
            type: String,
            required: true,
            unique: true,
        },

        codeVerifier: {
            type: String,
            required: true,
            select: false,
        },

        orgId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Organization",
            required: true,
        },

        returnPath: {
            type: String,
            default: "/dashboard",
        },

        usedAt: {
            type: Date,
            default: null,
        },

        expiresAt: {
            type: Date,
            required: true,
            index: true,
        },
    },
    {
        timestamps: true,
    }
);

// MongoDB TTL sweeper removes expired states automatically.
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("OAuthState", oauthStateSchema);
