const Organization = require("../models/Organization");
const Review = require("../models/Review");

async function generateReply(review, orgId = null) {
    const rawRating = review ? review.rating : null;
    const comment = review ? (review.comment || review.text || "") : "";

    // Normalize rating to numeric value 1-5
    const ratingMap = {
        ONE: 1,
        TWO: 2,
        THREE: 3,
        FOUR: 4,
        FIVE: 5,
        "1": 1,
        "2": 2,
        "3": 3,
        "4": 4,
        "5": 5,
    };

    let numericRating = 3;
    if (typeof rawRating === "number" && rawRating >= 1 && rawRating <= 5) {
        numericRating = rawRating;
    } else if (typeof rawRating === "string") {
        const upper = rawRating.toUpperCase();
        numericRating = ratingMap[upper] || parseInt(rawRating, 10) || 3;
    }

    let draftReply = "";
    let sentiment = "neutral";
    let urgency = "low";
    let needsHumanReview = false;
    let usedOpenAI = false;

    // Determine initial sentiment based on rating
    if (numericRating >= 4) {
        sentiment = "positive";
    } else if (numericRating === 3) {
        sentiment = "neutral";
    } else {
        sentiment = "negative";
        urgency = "medium";
        needsHumanReview = true;
    }

    // Determine API Key & Enabled status
    let apiKeyToUse = null;
    let openAiDisabled = false;

    if (orgId) {
        try {
            const org = await Organization.findById(orgId).select("+openaiApiKey");
            if (org) {
                if (org.openaiEnabled === false) {
                    openAiDisabled = true;
                } else if (org.openaiApiKey && org.openaiApiKey.trim() !== "") {
                    apiKeyToUse = org.openaiApiKey.trim();
                }
            }
        } catch (err) {
            console.error("Error fetching organization OpenAI settings:", err.message);
        }
    }

    // Fallback to environment variable if org key not present and OpenAI not disabled
    if (!apiKeyToUse && !openAiDisabled) {
        if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== "") {
            apiKeyToUse = process.env.OPENAI_API_KEY.trim();
        }
    }

    // 1. Try OpenAI if key is available and OpenAI usage is enabled
    if (apiKeyToUse && !openAiDisabled) {
        try {
            const { OpenAI } = require("openai");
            const openai = new OpenAI({ apiKey: apiKeyToUse });
            const prompt = `You are a professional customer relation manager. Write a concise, friendly, and professional Google review reply that directly addresses the customer's comment. Use only information present in the comment. Do not include any greetings, signatures, placeholders, or mention of stars. Match the tone to the ${numericRating}-star rating (positive for 4-5, neutral for 3, apologetic for 1-2). Keep it under 150 words.`;

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 150,
            });

            if (response && response.choices && response.choices[0]?.message?.content) {
                draftReply = response.choices[0].message.content.trim();
                usedOpenAI = true;
            }
        } catch (err) {
            let sanitizedMsg = err.message || "OpenAI API call failed";
            if (apiKeyToUse && typeof apiKeyToUse === "string") {
                sanitizedMsg = sanitizedMsg.split(apiKeyToUse).join("[REDACTED]");
            }
            console.error("OpenAI generation failed, falling back to safe fallback reply:", sanitizedMsg);
        }
    }

    // 2. Safe fallback implementation if OpenAI was not used or failed
    if (!draftReply) {
        if (numericRating >= 4) {
            draftReply =
                "Thank you so much for your wonderful review! " +
                "We're glad you enjoyed your experience with us. " +
                "We look forward to welcoming you again!";
        } else if (numericRating === 3) {
            draftReply =
                "Thank you for sharing your feedback with us. " +
                "We appreciate your visit and will continue working to improve your experience.";
        } else {
            draftReply =
                "We're sorry to hear that your experience did not meet your expectations. " +
                "Thank you for bringing this to our attention. " +
                "We would appreciate the opportunity to understand your concerns better.";
        }
    }

    // 3. High-risk review terms check (ALWAYS RUNS for safety)
    const seriousWords = [
        "unsafe",
        "food poisoning",
        "allergy",
        "harassment",
        "discrimination",
        "fraud",
        "legal",
        "lawyer",
        "threat",
        "police",
    ];

    const lowerComment = comment.toLowerCase();
    for (const word of seriousWords) {
        if (lowerComment.includes(word)) {
            needsHumanReview = true;
            urgency = "high";
            break;
        }
    }

    return { sentiment, draftReply, needsHumanReview, urgency, usedOpenAI };
}

async function generateAnalysis(orgId) {
    let reviews = [];
    if (orgId) {
        try {
            reviews = await Review.find({ orgId }).sort({ createdAt: -1 }).limit(20);
        } catch (err) {
            console.error("Error fetching reviews for AI analysis:", err.message);
        }
    }

    const totalCount = reviews.length;
    const positiveCount = reviews.filter((r) => r.sentiment === "positive" || r.rating >= 4).length;
    const neutralCount = reviews.filter((r) => r.sentiment === "neutral" || r.rating === 3).length;
    const negativeCount = reviews.filter((r) => r.sentiment === "negative" || r.rating <= 2).length;

    const positivePct = totalCount > 0 ? Math.round((positiveCount / totalCount) * 100) : 100;

    let fallbackSummary = totalCount > 0
        ? `Analysis of ${totalCount} recent review${totalCount === 1 ? "" : "s"}: ${positivePct}% positive customer sentiment (${positiveCount} positive, ${neutralCount} neutral, ${negativeCount} negative). Customer satisfaction remains strong with high rating consistency.`
        : "No review data available yet for AI sentiment analysis. Once customer reviews are ingested, insights will appear here.";

    let apiKeyToUse = null;
    let openAiDisabled = false;

    if (orgId) {
        try {
            const org = await Organization.findById(orgId).select("+openaiApiKey");
            if (org) {
                if (org.openaiEnabled === false) {
                    openAiDisabled = true;
                } else if (org.openaiApiKey && org.openaiApiKey.trim() !== "") {
                    apiKeyToUse = org.openaiApiKey.trim();
                }
            }
        } catch (err) {
            console.error("Error fetching org config for AI analysis:", err.message);
        }
    }

    if (!apiKeyToUse && !openAiDisabled) {
        if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== "") {
            apiKeyToUse = process.env.OPENAI_API_KEY.trim();
        }
    }

    if (apiKeyToUse && !openAiDisabled && totalCount > 0) {
        try {
            const { OpenAI } = require("openai");
            const openai = new OpenAI({ apiKey: apiKeyToUse });
            const commentsText = reviews
                .map((r) => `[Rating ${r.rating}/5]: "${r.text || "No text provided"}"`)
                .join("\n");

            const prompt = `Analyze ${totalCount === 1 ? "this 1 customer review" : `these ${totalCount} customer reviews`} and provide a concise 2-3 sentence executive summary of overall sentiment, key customer praise, and main complaints:\n\n${commentsText}`;

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 500,
            });
            if (response && response.choices && response.choices[0]?.message?.content) {
                return {
                    summary: response.choices[0].message.content.trim(),
                    usedOpenAI: true,
                };
            }
        } catch (err) {
            let sanitizedMsg = err.message || "OpenAI API call failed";
            if (apiKeyToUse && typeof apiKeyToUse === "string") {
                sanitizedMsg = sanitizedMsg.split(apiKeyToUse).join("[REDACTED]");
            }
            console.error("OpenAI analysis failed, using fallback:", sanitizedMsg);
        }
    }

    return {
        summary: fallbackSummary,
        usedOpenAI: false,
    };
}

module.exports = generateReply;
module.exports.generateReply = generateReply;
module.exports.generateAnalysis = generateAnalysis;