async function generateReply(review) {
    const rawRating = review.rating;
    const comment = review.comment || "";

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

    // 1. Try OpenAI if key is present
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== "") {
        try {
            const { OpenAI } = require("openai");
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
            const prompt = `You are a professional customer relation manager. Generate a polite, empathetic Google review reply for a ${numericRating}-star rating with customer comment: "${comment}". Keep it under 150 words.`;
            
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 150,
            });

            if (response && response.choices && response.choices[0]?.message?.content) {
                draftReply = response.choices[0].message.content.trim();
                usedOpenAI = true;
            }
        } catch (err) {
            console.error("OpenAI generation failed, falling back to mock reply:", err.message);
        }
    }

    // 2. Fallback mock implementation if OpenAI was not used or failed
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

module.exports = generateReply;