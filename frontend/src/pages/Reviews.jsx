import { useState, useEffect, useMemo } from "react";
import { reviewsService, replyService } from "../services/api";
import { ReviewCard } from "../components/ReviewCard";
import { Loading } from "../components/Loading";
import { ErrorMessage } from "../components/ErrorMessage";

export function Reviews() {
    const [reviews, setReviews] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [sentimentFilter, setSentimentFilter] = useState("all");
    const [successBanner, setSuccessBanner] = useState(null);

    const loadReviews = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await reviewsService.getAll();
            if (data.success && data.reviews) {
                setReviews(data.reviews);
            }
        } catch (err) {
            setError(
                err.response?.data?.message ||
                "Failed to fetch reviews from server."
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadReviews();
    }, []);

    const handleApprove = async (reviewId, finalReply) => {
        const res = await replyService.approve(reviewId, finalReply);
        if (res.success) {
            setSuccessBanner("Reply approved successfully!");
            setTimeout(() => setSuccessBanner(null), 4000);
            // Update review locally
            setReviews((prev) =>
                prev.map((r) =>
                    r._id === reviewId
                        ? {
                              ...r,
                              status: "replied",
                              reply: {
                                  ...r.reply,
                                  status: "approved",
                                  finalReply: finalReply || r.reply?.draftReply,
                              },
                          }
                        : r
                )
            );
        }
    };

    const handleReject = async (reviewId) => {
        const res = await replyService.reject(reviewId);
        if (res.success) {
            setSuccessBanner("Reply rejected successfully.");
            setTimeout(() => setSuccessBanner(null), 4000);
            // Update review locally
            setReviews((prev) =>
                prev.map((r) =>
                    r._id === reviewId
                        ? {
                              ...r,
                              status: "rejected",
                              reply: {
                                  ...r.reply,
                                  status: "rejected",
                              },
                          }
                        : r
                )
            );
        }
    };

    // Filter reviews
    const filteredReviews = useMemo(() => {
        return reviews.filter((r) => {
            // Status filter
            if (statusFilter !== "all" && r.status !== statusFilter) {
                return false;
            }
            // Sentiment filter
            if (sentimentFilter !== "all" && r.sentiment !== sentimentFilter) {
                return false;
            }
            // Search query
            if (searchTerm.trim()) {
                const term = searchTerm.toLowerCase();
                const name = (r.reviewerName || "").toLowerCase();
                const text = (r.text || "").toLowerCase();
                const loc = (r.locationId?.name || "").toLowerCase();
                if (!name.includes(term) && !text.includes(term) && !loc.includes(term)) {
                    return false;
                }
            }
            return true;
        });
    }, [reviews, statusFilter, sentimentFilter, searchTerm]);

    if (loading) {
        return <Loading message="Loading customer reviews..." />;
    }

    if (error && reviews.length === 0) {
        return <ErrorMessage message={error} onRetry={loadReviews} />;
    }

    return (
        <div className="reviews-page">
            <div className="page-header-row">
                <div>
                    <h2 className="section-title">All Customer Reviews</h2>
                    <p className="section-subtitle">
                        Browse, filter, and inspect reviews ingested from your Google Business Profile.
                    </p>
                </div>
                <button
                    type="button"
                    className="btn btn-secondary btn-refresh"
                    onClick={loadReviews}
                >
                    🔄 Refresh
                </button>
            </div>

            {successBanner && (
                <div className="alert alert-success alert-dismissible">
                    <span>✓ {successBanner}</span>
                    <button
                        type="button"
                        className="btn-dismiss"
                        onClick={() => setSuccessBanner(null)}
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* Controls & Filters Bar */}
            <div className="filter-card">
                <div className="search-bar">
                    <span className="search-icon">🔍</span>
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Search reviewer name, review text, or location..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                    {searchTerm && (
                        <button
                            type="button"
                            className="btn-clear-search"
                            onClick={() => setSearchTerm("")}
                        >
                            ✕
                        </button>
                    )}
                </div>

                <div className="filter-group-row">
                    <div className="filter-group">
                        <label className="filter-label">Status:</label>
                        <select
                            className="filter-select"
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                        >
                            <option value="all">All Statuses ({reviews.length})</option>
                            <option value="pending">Pending</option>
                            <option value="approved">Approved</option>
                            <option value="published">Published</option>
                            <option value="replied">Replied</option>
                            <option value="rejected">Rejected</option>
                        </select>
                    </div>

                    <div className="filter-group">
                        <label className="filter-label">Sentiment:</label>
                        <select
                            className="filter-select"
                            value={sentimentFilter}
                            onChange={(e) => setSentimentFilter(e.target.value)}
                        >
                            <option value="all">All Sentiments</option>
                            <option value="positive">Positive 🟢</option>
                            <option value="neutral">Neutral ⚪</option>
                            <option value="negative">Negative 🔴</option>
                        </select>
                    </div>

                    {(statusFilter !== "all" || sentimentFilter !== "all" || searchTerm) && (
                        <button
                            type="button"
                            className="btn-reset-filters"
                            onClick={() => {
                                setStatusFilter("all");
                                setSentimentFilter("all");
                                setSearchTerm("");
                            }}
                        >
                            Clear Filters
                        </button>
                    )}
                </div>
            </div>

            {/* Results Counter */}
            <div className="results-counter">
                Showing <strong>{filteredReviews.length}</strong> of <strong>{reviews.length}</strong> reviews
            </div>

            {/* Reviews List or Empty State */}
            {filteredReviews.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-state-icon">📭</div>
                    <h3 className="empty-state-title">No Reviews Found</h3>
                    <p className="empty-state-desc">
                        {reviews.length === 0
                            ? "You don't have any reviews yet. Incoming reviews via Make.com will appear here."
                            : "No reviews matched your current search or filter criteria."}
                    </p>
                    {(statusFilter !== "all" || sentimentFilter !== "all" || searchTerm) && (
                        <button
                            type="button"
                            className="btn btn-secondary mt-3"
                            onClick={() => {
                                setStatusFilter("all");
                                setSentimentFilter("all");
                                setSearchTerm("");
                            }}
                        >
                            Reset All Filters
                        </button>
                    )}
                </div>
            ) : (
                <div className="reviews-list">
                    {filteredReviews.map((review) => (
                        <ReviewCard
                            key={review._id}
                            review={review}
                            onApprove={handleApprove}
                            onReject={handleReject}
                            showReplyEditor={true}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
