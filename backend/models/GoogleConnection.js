const mongoose = require("mongoose");

const googleConnectionSchema = new mongoose.Schema(
    {
        orgId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Organization",
            required: true,
            index: true,
        },

        googleAccountEmail: {
            type: String,
            default: "",
        },

        // OpenID Connect subject (userinfo.sub). NOT a Business Profile
        // accounts/{id} value — that lives on Location.googleAccountId.
        googleUserSub: {
            type: String,
            default: "",
        },

        // Legacy alias of googleUserSub (OIDC subject). Kept for compatibility
        // with documents written before googleUserSub existed. Do not treat as
        // a GBP account id.
        googleAccountId: {
            type: String,
            default: "",
        },

        // Versioned AES-GCM ciphertext. Never returned by default API serializers.
        encryptedAccessToken: {
            type: String,
            required: true,
            select: false,
        },

        encryptedRefreshToken: {
            type: String,
            required: true,
            select: false,
        },

        accessTokenExpiresAt: {
            type: Date,
            default: null,
        },

        scopes: {
            type: [String],
            default: [],
        },

        status: {
            type: String,
            enum: ["active", "revoked", "error"],
            default: "active",
        },

        lastError: {
            type: String,
            default: "",
        },

        connectedAt: {
            type: Date,
            default: Date.now,
        },
    },
    {
        timestamps: true,
    }
);

googleConnectionSchema.index({ orgId: 1, status: 1 });

module.exports = mongoose.model("GoogleConnection", googleConnectionSchema);
