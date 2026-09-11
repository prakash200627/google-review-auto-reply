const mongoose = require("mongoose");

const organizationSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
        },

        email: {
            type: String,
            required: true,
            unique: true,
        },

        password: {
            type: String,
            required: true,
        },

        mode: {
            type: String,
            enum: ["manual", "auto"],
            default: "manual",
        },

        brandVoice: {
            type: String,
            enum: ["friendly", "professional", "casual", "premium"],
            default: "friendly",
        },

        language: {
            type: String,
            default: "English",
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Organization", organizationSchema);