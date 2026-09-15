const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const dns = require("dns");

dns.setServers(["8.8.8.8"]);

require("dotenv").config();

const Review = require("./models/Review");
const Reply = require("./models/Reply");
const Location = require("./models/Location");
const Organization = require("./models/Organization");
const axios = require("axios");

const organizationRoutes = require("./routes/organization");
const generateReply = require("./services/ai");

const authRoutes = require("./routes/auth");
const locationRoutes = require("./routes/location");
const reviewsRoutes = require("./routes/reviews");
const replyRoutes = require("./routes/reply");
const statsRoutes = require("./routes/stats");
// Import temporary test AI route


const app = express();

// CORS configuration for Vercel production and local development
const allowedOrigins = [
    "https://google-review-auto-reply.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
];

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps, curl, or server-to-server webhooks)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== "production") {
            return callback(null, true);
        }
        return callback(null, true); // Fallback allow to avoid CORS block
    },
    credentials: true,
}));

app.use(express.json());
app.use("/api/organization", organizationRoutes);

// =========================
// Routes
// =========================

app.use("/api/auth", authRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/reply", replyRoutes);
app.use("/api/stats", statsRoutes);
// Mount temporary test route under /api


// =========================
// Health Check
// =========================

app.get("/", (req, res) => {
    res.json({
        message: "Google Review Auto-Reply Backend is running",
    });
});

// =========================
// Google Review Webhook
// =========================

app.post("/api/webhook/review", async (req, res) => {
    try {
        console.log("\nNew review received:");
        console.log(req.body);

        const {
            reviewId,
            reviewerName,
            rating,
            comment,
            googleResourceName,
        } = req.body;

        // -------------------------
        // 1. Validate input
        // -------------------------

        if (!reviewId || !rating || !googleResourceName) {
            return res.status(400).json({
                success: false,
                message: "reviewId, rating and googleResourceName are required",
            });
        }

        // -------------------------
        // 2. Extract Google Location ID
        // -------------------------

        const locationMatch = googleResourceName.match(/\/locations\/([^/]+)\/reviews\//);

        if (!locationMatch) {
            console.error("Could not extract Google Location ID from:", googleResourceName);
            return res.status(400).json({
                success: false,
                message: "Invalid Google resource name",
            });
        }

        const googleLocationId = locationMatch[1];
        console.log("Google Location ID:", googleLocationId);

        // -------------------------
        // 3. Find our Location
        // -------------------------

        const location = await Location.findOne({ googleLocationId });
        if (!location) {
            console.error("Location not found in database:", googleLocationId);
            return res.status(404).json({
                success: false,
                message: "Google location is not registered",
                googleLocationId,
            });
        }

        console.log("Location found:", location._id);
        console.log("Organization:", location.orgId);

        // -------------------------
        // 4. Check duplicate review
        // -------------------------

        const existingReview = await Review.findOne({ googleReviewId: reviewId });
        if (existingReview) {
            if (reviewerName && !existingReview.reviewerName) {
                existingReview.reviewerName = reviewerName;
            }
            if (googleResourceName && !existingReview.googleResourceName) {
                existingReview.googleResourceName = googleResourceName;
            }
            await existingReview.save();
            const existingReply = await Reply.findOne({ reviewId: existingReview._id });
            return res.status(200).json({
                success: true,
                message: "Review already exists",
                reviewId: existingReview._id,
                replyId: existingReply ? existingReply._id : null,
            });
        }

        // -------------------------
        // 5. Convert Google rating
        // -------------------------

        const ratingMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
        const numericRating =
            ratingMap[rating] ||
            (typeof rating === "number" && rating >= 1 && rating <= 5 ? rating : null);
        if (!numericRating) {
            return res.status(400).json({ success: false, message: "Invalid Google star rating" });
        }

        // -------------------------
        // 6. Generate AI result
        // -------------------------
        const aiResult = await generateReply({ rating: numericRating, comment }, location.orgId);

        // -------------------------
        // 7. Save Review
        // -------------------------
        const review = await Review.create({
            orgId: location.orgId,
            locationId: location._id,
            googleReviewId: reviewId,
            reviewerName: reviewerName || "",
            rating: numericRating,
            text: comment || "",
            sentiment: aiResult.sentiment,
            status: "pending",
            googleResourceName,
        });

        // -------------------------
        // 8. Save Reply
        // -------------------------
        const reply = await Reply.create({
            reviewId: review._id,
            orgId: location.orgId,
            draftReply: aiResult.draftReply,
            needsHumanReview: aiResult.needsHumanReview,
            urgency: aiResult.urgency,
            status: "pending",
        });

        // -------------------------
        // 9. Success response (auto/manual handling)
        // -------------------------
        const organization = await Organization.findById(location.orgId);
        const isAuto = organization && organization.mode === "auto";

        if (isAuto && !aiResult.needsHumanReview) {
            const finalReply = aiResult.draftReply;
            reply.finalReply = finalReply;
            reply.status = "approved";
            await reply.save();
            review.status = "approved";
            await review.save();
            const webhookUrl = process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL;
            if (webhookUrl) {
                try {
                    await axios.post(webhookUrl, {
                        reviewId: review.googleReviewId || review._id,
                        reviewerName: review.reviewerName,
                        rating: review.rating,
                        comment: review.text,
                        googleResourceName: review.googleResourceName,
                        finalReply,
                        orgId: review.orgId,
                    });
                } catch (err) {
                    console.error("Failed to call Make.com webhook (auto mode):", err.message);
                    reply.status = "pending";
                    await reply.save();
                    review.status = "pending";
                    await review.save();
                    return res.status(502).json({
                        success: false,
                        message: "Auto reply generated but failed to notify Make.com webhook",
                        reviewId: review._id,
                        replyId: reply._id,
                    });
                }
            } else {
                console.error("MAKE_APPROVED_REPLY_WEBHOOK_URL not configured");
            }
            return res.status(201).json({
                success: true,
                autoProcessed: true,
                message: "Review saved and auto-reply sent",
                reviewId: review._id,
                replyId: reply._id,
            });
        }

        // Manual or high‑risk path
        return res.status(201).json({
            success: true,
            autoProcessed: false,
            message: "Review and reply saved successfully",
            reviewId: review._id,
            replyId: reply._id,
        });
    } catch (error) {
        console.error("Error processing review:", error);
        res.status(500).json({ success: false, message: "Failed to process review" });
    }
});

// =========================
// Start Server
// =========================

const PORT = process.env.PORT || 5000;
if (require.main === module) {
    mongoose
        .connect(process.env.MONGO_URI)
        .then(() => {
            console.log("MongoDB connected");
            app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
        })
        .catch((err) => {
            console.error("MongoDB connection failed:", err.message);
        });
}

module.exports = app;