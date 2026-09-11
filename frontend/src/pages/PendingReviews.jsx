import { useState, useEffect } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { reviewsService, replyService } from "../services/api";
import { ReviewCard } from "../components/ReviewCard";
import { Loading } from "../components/Loading";
import { ErrorMessage } from "../components/ErrorMessage";

export function PendingReviews() {
    const { refreshStats } = useOutletContext() || {};
    const [pendingReviews, setPendingReviews] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [notification, setNotification] = useState(null);

    const loadPendingReviews = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await reviewsService.getPending();
            if (data.success && data.reviews) {
                setPendingReviews(data.reviews);
            }
        } catch (err) {
            setError(
                err.response?.data?.message ||
                "Failed to fetch pending reviews from server."
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadPendingReviews();
    }, []);

    const showNotification = (message, type = "success") => {
        setNotification({ message, type });
        setTimeout(() => setNotification(null), 4000);
    };

    const handleApprove = async (reviewId, finalReply) => {
        const res = await replyService.approve(reviewId, finalReply);
        if (res.success) {
            showNotification("Reply approved successfully! The review has been marked as replied.");
            // Remove review from pending list immediately
            setPendingReviews((prev) => prev.filter((r) => r._id !== reviewId));
            // Trigger layout stats update
            if (refreshStats) refreshStats();
        }
    };

    const handleReject = async (reviewId) => {
        const res = await replyService.reject(reviewId);
        if (res.success) {
            showNotification("Reply rejected. The review has been dismissed.", "info");
            // Remove review from pending list immediately
            setPendingReviews((prev) => prev.filter((r) => r._id !== reviewId));
            // Trigger layout stats update
            if (refreshStats) refreshStats();
        }
    };

    if (loading) {
        return <Loading message="Loading pending reviews awaiting response..." />;
    }

    if (error && pendingReviews.length === 0) {
        return <ErrorMessage message={error} onRetry={loadPendingReviews} />;
    }

    return (
        <div className="pending-page">
            <div className="page-header-row">
                <div>
                    <div className="title-with-badge">
                        <h2 className="section-title">Pending Reviews Inbox</h2>
                        <span className="count-pill">
                            {pendingReviews.length} Awaiting Action
                        </span>
                    </div>
                    <p className="section-subtitle">
                        Inspect AI-drafted responses, edit tone if needed, and approve or reject before dispatch.
                    </p>
                </div>
                <button
                    type="button"
                    className="btn btn-secondary btn-refresh"
                    onClick={loadPendingReviews}
                >
                    🔄 Refresh
                </button>
            </div>

            {notification && (
                <div
                    className={`alert ${
                        notification.type === "info" ? "alert-info" : "alert-success"
                    } alert-dismissible`}
                >
                    <span>{notification.type === "info" ? "ℹ️" : "✓"} {notification.message}</span>
                    <button
                        type="button"
                        className="btn-dismiss"
                        onClick={() => setNotification(null)}
                    >
                        ✕
                    </button>
                </div>
            )}

            {pendingReviews.length === 0 ? (
                <div className="empty-state inbox-zero">
                    <div className="empty-state-icon">🎉</div>
                    <h3 className="empty-state-title">Inbox Zero!</h3>
                    <p className="empty-state-desc">
                        All pending reviews have been processed. Great job! Incoming reviews received from Google Maps via Make.com will automatically arrive here.
                    </p>
                    <div className="empty-state-actions">
                        <Link to="/dashboard" className="btn btn-secondary">
                            ← Return to Dashboard
                        </Link>
                        <Link to="/reviews" className="btn btn-primary">
                            Browse All Reviews →
                        </Link>
                    </div>
                </div>
            ) : (
                <div className="pending-reviews-feed">
                    <div className="inbox-summary-banner">
                        <span className="inbox-tip">💡 <strong>Tip:</strong> You can click <em>"Edit Draft"</em> to personalize the AI reply with specific customer names or promo codes before approving.</span>
                    </div>

                    <div className="reviews-list">
                        {pendingReviews.map((review) => (
                            <ReviewCard
                                key={review._id}
                                review={review}
                                onApprove={handleApprove}
                                onReject={handleReject}
                                showReplyEditor={true}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
