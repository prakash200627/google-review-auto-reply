function generateReply(review) {
    const rating = review.rating;
    const comment = review.comment || "";

    let sentiment = "neutral";
    let urgency = "low";
    let needsHumanReview = false;
    let draftReply = "";

    // Determine sentiment from rating
    if (rating === "FIVE" || rating === "FOUR") {
        sentiment = "positive";

        draftReply =
            "Thank you so much for your wonderful review! " +
            "We're glad you enjoyed your experience with us. " +
            "We look forward to welcoming you again!";

    } else if (rating === "THREE") {
        sentiment = "neutral";

        draftReply =
            "Thank you for sharing your feedback with us. " +
            "We appreciate your visit and will continue working to improve your experience.";

    } else {
        sentiment = "negative";

        urgency = "medium";
        needsHumanReview = true;

        draftReply =
            "We're sorry to hear that your experience did not meet your expectations. " +
            "Thank you for bringing this to our attention. " +
            "We would appreciate the opportunity to understand your concerns better.";
    }

    // Check for potentially serious issues
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
        "police"
    ];

    const lowerComment = comment.toLowerCase();

    for (const word of seriousWords) {
        if (lowerComment.includes(word)) {
            needsHumanReview = true;
            urgency = "high";
            break;
        }
    }

    return {
        sentiment,
        draftReply,
        needsHumanReview,
        urgency
    };
}

module.exports = generateReply;