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

        googleLocationId: {
            type: String,
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Location", locationSchema);