const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const dns = require("dns");

dns.setServers(["8.8.8.8"]);

require("dotenv").config();

const Review = require("./models/Review");
const Reply = require("./models/Reply");
const Location = require("./models/Location");

const generateReply = require("./services/ai");

const authRoutes = require("./routes/auth");
const locationRoutes = require("./routes/location");
const reviewsRoutes = require("./routes/reviews");
const replyRoutes = require("./routes/reply");
const statsRoutes = require("./routes/stats");

const app = express();

app.use(cors());
app.use(express.json());


// =========================
// Routes
// =========================

app.use("/api/auth", authRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/reply", replyRoutes);
app.use("/api/stats", statsRoutes);

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
                message:
                    "reviewId, rating and googleResourceName are required",
            });
        }


        // -------------------------
        // 2. Extract Google Location ID
        // -------------------------

        const locationMatch = googleResourceName.match(
            /\/locations\/([^/]+)\/reviews\//
        );

        if (!locationMatch) {
            console.error(
                "Could not extract Google Location ID from:",
                googleResourceName
            );

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

        const location = await Location.findOne({
            googleLocationId,
        });

        if (!location) {
            console.error(
                "Location not found in database:",
                googleLocationId
            );

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

        const existingReview = await Review.findOne({
            googleReviewId: reviewId,
        });

        if (existingReview) {
            // Update reviewer name if it was missing before
            if (reviewerName && !existingReview.reviewerName) {
                existingReview.reviewerName = reviewerName;
            }
            // Update googleResourceName if missing and provided
            if (googleResourceName && !existingReview.googleResourceName) {
                existingReview.googleResourceName = googleResourceName;
            }
            await existingReview.save();

            const existingReply = await Reply.findOne({
                reviewId: existingReview._id,
            });

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

        const ratingMap = {
            ONE: 1,
            TWO: 2,
            THREE: 3,
            FOUR: 4,
            FIVE: 5,
        };

        const numericRating =
            ratingMap[rating] ||
            (typeof rating === "number" && rating >= 1 && rating <= 5
                ? rating
                : null);

        if (!numericRating) {
            return res.status(400).json({
                success: false,
                message: "Invalid Google star rating",
            });
        }


        // -------------------------
        // 6. Generate AI result
        // -------------------------

        const aiResult = generateReply({
            rating,
            comment,
        });


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
            googleResourceName: googleResourceName,
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
        // 9. Success response
        // -------------------------

        res.status(201).json({
            success: true,
            message: "Review and reply saved successfully",
            reviewId: review._id,
            replyId: reply._id,
        });

    } catch (error) {
        console.error(
            "Error processing review:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Failed to process review",
        });
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

            app.listen(PORT, () => {
                console.log(`Server running on port ${PORT}`);
            });
        })
        .catch((err) => {
            console.error(
                "MongoDB connection failed:",
                err.message
            );
        });
}

module.exports = app;