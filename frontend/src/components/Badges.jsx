export function StatusBadge({ status }) {
    const s = (status || "pending").toLowerCase();
    const map = {
        pending: { label: "Pending", className: "badge-status-pending" },
        approved: { label: "Approved", className: "badge-status-approved" },
        replied: { label: "Replied", className: "badge-status-replied" },
        published: { label: "Published", className: "badge-status-published" },
        rejected: { label: "Rejected", className: "badge-status-rejected" },
    };
    const current = map[s] || { label: status, className: "badge-status-neutral" };
    return <span className={`badge ${current.className}`}>{current.label}</span>;
}

export function SentimentBadge({ sentiment }) {
    const s = (sentiment || "neutral").toLowerCase();
    const map = {
        positive: { label: "Positive", className: "badge-sentiment-positive", icon: "🟢" },
        neutral: { label: "Neutral", className: "badge-sentiment-neutral", icon: "⚪" },
        negative: { label: "Negative", className: "badge-sentiment-negative", icon: "🔴" },
    };
    const current = map[s] || { label: sentiment, className: "badge-sentiment-neutral", icon: "⚪" };
    return (
        <span className={`badge ${current.className}`}>
            <span className="badge-dot" />
            {current.label}
        </span>
    );
}

export function UrgencyBadge({ urgency }) {
    const u = (urgency || "low").toLowerCase();
    const map = {
        high: { label: "High Urgency", className: "badge-urgency-high" },
        medium: { label: "Medium Urgency", className: "badge-urgency-medium" },
        low: { label: "Standard", className: "badge-urgency-low" },
    };
    const current = map[u] || { label: urgency, className: "badge-urgency-low" };
    return <span className={`badge ${current.className}`}>{current.label}</span>;
}

export function StarRating({ rating }) {
    // Map textual rating enums (e.g., "FIVE") to numeric values
    const ratingMap = {
        ONE: 1,
        TWO: 2,
        THREE: 3,
        FOUR: 4,
        FIVE: 5,
    };
    // Resolve numeric rating from possible string or number input
    let numericRating = 0;
    if (typeof rating === "string") {
        const upper = rating.toUpperCase();
        numericRating = ratingMap[upper] !== undefined ? ratingMap[upper] : Number(rating) || 0;
    } else if (typeof rating === "number") {
        numericRating = rating;
    }
    // Clamp between 0 and 5 and ensure integer
    const num = Math.min(Math.max(Math.floor(numericRating), 0), 5);
    const stars = [];
    for (let i = 1; i <= 5; i++) {
        stars.push(
            <span key={i} className={i <= num ? "star-filled" : "star-empty"}>
                ★
            </span>
        );
    }
    return <span className="star-rating">{stars}</span>;
}
