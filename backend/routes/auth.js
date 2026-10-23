const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const Organization = require("../models/Organization");
const createRateLimiter = require("../middleware/rateLimit");

const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
// bcrypt ignores input beyond 72 bytes.
const MAX_PASSWORD_LENGTH = 72;

const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many login attempts. Please try again in a few minutes.",
});

const registerLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: "Too many registration attempts. Please try again later.",
});

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}

// Register
router.post("/register", registerLimiter, async (req, res) => {
    try {
        const { name, email, password } = req.body || {};

        if (!isNonEmptyString(name) || !isNonEmptyString(email) || !isNonEmptyString(password)) {
            return res.status(400).json({
                success: false,
                message: "Name, email and password are required",
            });
        }

        const trimmedName = name.trim();
        const trimmedEmail = email.trim();

        if (trimmedName.length > 100) {
            return res.status(400).json({ success: false, message: "Name must be at most 100 characters" });
        }

        if (trimmedEmail.length > 254 || !EMAIL_PATTERN.test(trimmedEmail)) {
            return res.status(400).json({ success: false, message: "A valid email address is required" });
        }

        if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
            });
        }

        const existingOrganization = await Organization.findOne({ email: trimmedEmail });

        if (existingOrganization) {
            return res.status(400).json({
                success: false,
                message: "Organization already exists",
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const organization = await Organization.create({
            name: trimmedName,
            email: trimmedEmail,
            password: hashedPassword,
        });

        res.status(201).json({
            success: true,
            message: "Organization registered successfully",
            organizationId: organization._id,
        });
    } catch (error) {
        if (error && error.code === 11000) {
            return res.status(400).json({ success: false, message: "Organization already exists" });
        }
        console.error("Register error:", error.message);

        res.status(500).json({
            success: false,
            message: "Registration failed",
        });
    }
});

// Login
router.post("/login", loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body || {};

        if (!isNonEmptyString(email) || typeof password !== "string" || password === "") {
            return res.status(400).json({
                success: false,
                message: "Email and password are required",
            });
        }

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
                algorithm: "HS256",
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

router.loginLimiter = loginLimiter;
router.registerLimiter = registerLimiter;

module.exports = router;
