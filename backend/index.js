const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

// Tests configure their own environment and must never read real credentials.
if (process.env.NODE_ENV !== "test") {
    require("dotenv").config();
}

const { isProductionRuntime, configureDnsServers } = require("./config/runtime");
configureDnsServers();

const organizationRoutes = require("./routes/organization");
const authRoutes = require("./routes/auth");
const locationRoutes = require("./routes/location");
const reviewsRoutes = require("./routes/reviews");
const replyRoutes = require("./routes/reply");
const statsRoutes = require("./routes/stats");
const googleRoutes = require("./routes/google");
const { isOAuthConfigured } = require("./services/googleOAuth");
const { isEncryptionConfigured } = require("./services/tokenEncryption");
const { startReviewSyncScheduler } = require("./services/reviewSync");

const app = express();

// Render terminates TLS at a proxy; trust it so req.ip is the real client (used for rate limiting).
app.set("trust proxy", 1);

const allowedOrigins = [
    "https://google-review-auto-reply.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    ...(process.env.CORS_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean),
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== "production") {
            return callback(null, true);
        }
        return callback(null, false);
    },
    credentials: true,
}));

app.use(express.json({ limit: "100kb" }));
app.use("/api/organization", organizationRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/reply", replyRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/google", googleRoutes);

app.get("/", (req, res) => {
    res.json({
        message: "Google Review Auto-Reply Backend is running",
        googleOAuthConfigured: isOAuthConfigured(),
    });
});

// Explicitly reject retired Make.com webhook endpoints so they cannot trigger workflows.
app.post("/api/webhook/review", (req, res) => {
    res.status(410).json({
        success: false,
        message: "Make.com review ingestion has been removed. Connect Google Business Profile and use scheduled sync.",
    });
});
app.post("/api/webhook/publish-result", (req, res) => {
    res.status(410).json({
        success: false,
        message: "Make.com publish callbacks have been removed. Replies are published directly to Google.",
    });
});
app.use("/api/webhook", (req, res) => {
    res.status(410).json({
        success: false,
        message: "Webhook integrations have been removed",
    });
});

app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
        return res.status(400).json({ success: false, message: "Request body must be valid JSON" });
    }
    if (err && err.type === "entity.too.large") {
        return res.status(413).json({ success: false, message: "Request body is too large" });
    }
    console.error("Unhandled error:", err && err.message);
    const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
    return res.status(status).json({
        success: false,
        message: status === 500 ? "Internal server error" : (err.message || "Request failed"),
    });
});

const PORT = process.env.PORT || 5000;
if (require.main === module) {
    const missing = ["MONGO_URI", "JWT_SECRET"].filter((name) => !process.env[name]);
    if (missing.length) {
        console.error(`Missing required environment variables: ${missing.join(", ")}`);
        process.exit(1);
    }

    if (!isOAuthConfigured()) {
        console.error(
            "Google OAuth is not fully configured " +
            "(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_TOKEN_ENCRYPTION_KEY). " +
            "Connect/sync/publish endpoints will return errors until these are set."
        );
    } else if (!isEncryptionConfigured()) {
        console.error("GOOGLE_TOKEN_ENCRYPTION_KEY is invalid; token storage is disabled.");
    }

    if (isProductionRuntime() && !(process.env.FRONTEND_URL || "").trim()) {
        console.warn("FRONTEND_URL is not set; OAuth callback redirects will use the default Vercel URL.");
    }

    mongoose
        .connect(process.env.MONGO_URI)
        .then(() => {
            console.log("MongoDB connected");
            app.listen(PORT, () => {
                console.log(`Server running on port ${PORT}`);
                startReviewSyncScheduler();
            });
        })
        .catch((err) => {
            console.error("MongoDB connection failed:", err.message);
            process.exit(1);
        });
}

module.exports = app;
