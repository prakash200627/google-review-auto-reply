const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const Organization = require("../models/Organization");

const router = express.Router();

// Register
router.post("/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "Name, email and password are required",
            });
        }

        const existingOrganization = await Organization.findOne({ email });

        if (existingOrganization) {
            return res.status(400).json({
                success: false,
                message: "Organization already exists",
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const organization = await Organization.create({
            name,
            email,
            password: hashedPassword,
        });

        res.status(201).json({
            success: true,
            message: "Organization registered successfully",
            organizationId: organization._id,
        });
    } catch (error) {
        console.error("Register error:", error.message);

        res.status(500).json({
            success: false,
            message: "Registration failed",
        });
    }
});

// Login
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const organization = await Organization.findOne({ email });

        if (!organization) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        const passwordMatch = await bcrypt.compare(
            password,
            organization.password
        );

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        const token = jwt.sign(
            {
                organizationId: organization._id,
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "7d",
            }
        );

        res.json({
            success: true,
            message: "Login successful",
            token,
            organization: {
                id: organization._id,
                name: organization.name,
                email: organization.email,
                mode: organization.mode,
                brandVoice: organization.brandVoice,
                language: organization.language,
            },
        });
    } catch (error) {
        console.error("Login error:", error.message);

        res.status(500).json({
            success: false,
            message: "Login failed",
        });
    }
});

module.exports = router;