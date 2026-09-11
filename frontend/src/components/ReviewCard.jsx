import { StarRating, SentimentBadge, StatusBadge } from "./Badges";
import { ReplyEditor } from "./ReplyEditor";

export function ReviewCard({
    review,
    onApprove,
    onReject,
    showReplyEditor = true,
}) {
    if (!review) return null;

    const locationName =
        review.locationId?.name ||
        review.locationId?.googleLocationId ||
        "Default Location";

    const formattedDate = review.createdAt
        ? new Date(review.createdAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
          })
        : null;

    return (
        <div className="review-card">
            <div className="review-card-top">
                <div className="review-author-meta">
                    <div className="avatar-circle">
                        {(review.reviewerName || "A")[0].toUpperCase()}
                    </div>
                    <div>
                        <h4 className="reviewer-name">
                            {review.reviewerName || "Anonymous Customer"}
                        </h4>
                        <div className="review-sub-info">
                            <StarRating rating={review.rating} />
                            <span className="info-dot">•</span>
                            <span className="location-tag">📍 {locationName}</span>
                            {formattedDate && (
                                <>
                                    <span className="info-dot">•</span>
                                    <span className="date-tag">{formattedDate}</span>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                <div className="review-badges">
                    <SentimentBadge sentiment={review.sentiment} />
                    <StatusBadge status={review.status} />
                </div>
            </div>

            <div className="review-text-wrapper">
                <p className="review-text">
                    {review.text ? `"${review.text}"` : <em className="text-muted">No comment provided with rating.</em>}
                </p>
            </div>

            {showReplyEditor && review.reply && (
                <div className="review-reply-section">
                    <ReplyEditor
                        review={review}
                        reply={review.reply}
                        onApprove={onApprove}
                        onReject={onReject}
                        readOnly={review.status !== "pending"}
                    />
                </div>
            )}
        </div>
    );
}
