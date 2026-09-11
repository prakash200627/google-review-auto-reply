const express = require("express");

const Location = require("../models/Location");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Add a location
router.post("/", authMiddleware, async (req, res) => {
    try {
        const { name, googleLocationId } = req.body;

        if (!name || !googleLocationId) {
            return res.status(400).json({
                success: false,
                message: "Name and Google Location ID are required",
            });
        }

        const existingLocation = await Location.findOne({
            googleLocationId,
        });

        if (existingLocation) {
            if (existingLocation.orgId.toString() === req.organizationId.toString()) {
                return res.status(400).json({
                    success: false,
                    message: "Location is already added for this organization",
                    location: existingLocation,
                });
            } else {
                return res.status(400).json({
                    success: false,
                    message: "Google Location ID is already registered to another organization",
                });
            }
        }

        const location = await Location.create({
            orgId: req.organizationId,
            name,
            googleLocationId,
        });

        res.status(201).json({
            success: true,
            message: "Location added successfully",
            location,
        });
    } catch (error) {
        console.error("Add location error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to add location",
        });
    }
});

// Get organization's locations
router.get("/", authMiddleware, async (req, res) => {
    try {
        const locations = await Location.find({
            orgId: req.organizationId,
        });

        res.json({
            success: true,
            locations,
        });
    } catch (error) {
        console.error("Get locations error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to get locations",
        });
    }
});

module.exports = router;