import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { statsService, reviewsService } from "../services/api";
import { StatCard } from "../components/StatCard";
import { ReviewCard } from "../components/ReviewCard";
import { Loading } from "../components/Loading";
import { ErrorMessage } from "../components/ErrorMessage";
import { useAuth } from "../context/AuthContext";

export function Dashboard() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const [stats, setStats] = useState(null);
    const [recentPending, setRecentPending] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const loadDashboardData = async () => {
        setLoading(true);
        setError(null);
        try {
            const [statsData, pendingData] = await Promise.all([
                statsService.getStats(),
                reviewsService.getPending(),
            ]);

            if (statsData.success) {
                setStats(statsData.stats);
            }
            if (pendingData.success && pendingData.reviews) {
                setRecentPending(pendingData.reviews.slice(0, 3));
            }
        } catch (err) {
            setError(
                err.response?.data?.message ||
                "Failed to load dashboard statistics. Please verify backend connection."
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadDashboardData();
    }, []);

    if (loading) {
        return <Loading message="Loading dashboard statistics..." />;
    }

    if (error && !stats) {
        return <ErrorMessage message={error} onRetry={loadDashboardData} />;
    }

    return (
        <div className="dashboard-page">
            {/* Header Banner */}
            <div className="page-header-row">
                <div>
                    <h2 className="section-title">
                        Welcome back, {user?.name || "Organization"}! &#x1F44B;
                    </h2>
                    <p className="section-subtitle">
                        Here is an overview of your Google review metrics, response drafts, and pending approvals.
                    </p>
                </div>
                <button
                    type="button"
                    className="btn btn-secondary btn-refresh"
                    onClick={loadDashboardData}
                >
                    &#x1F504; Refresh Data
                </button>
            </div>

            {/* Attention Alert if pending reviews exist */}
            {stats && stats.pendingReviews > 0 && (
                <div className="alert-banner-inbox">
                    <div className="alert-banner-content">
                        <span className="alert-banner-icon">&#x26A1;</span>
                        <div>
                            <strong>{stats.pendingReviews} review{stats.pendingReviews > 1 ? "s" : ""} waiting for your response!</strong>
                            <p>AI draft replies are ready for review, edit, or approval.</p>
                        </div>
                    </div>
                    <Link to="/pending" className="btn btn-primary btn-sm">
                        Go to Inbox &#x2192;
                    </Link>
                </div>
            )}

            {/* Core Review Stats Grid */}
            <div className="stats-section">
                <h3 className="subheading">Review Volume &amp; Pipeline</h3>
                <div className="stats-grid">
                    <StatCard
                        title="Total Reviews"
                        value={stats?.totalReviews}
                        subtitle="All Google reviews received"
                        icon="&#x2B50;"
                        variant="primary"
                        onClick={() => navigate("/reviews")}
                    />
                    <StatCard
                        title="Pending Reviews"
                        value={stats?.pendingReviews}
                        subtitle="Awaiting approval / action"
                        icon="&#x23F3;"
                        variant="warning"
                        onClick={() => navigate("/pending")}
                    />
                    <StatCard
                        title="Replied Reviews"
                        value={stats?.repliedReviews}
                        subtitle="Replies approved / handled"
                        icon="&#x2705;"
                        variant="success"
                        onClick={() => navigate("/reviews")}
                    />
                    <StatCard
                        title="Rejected Reviews"
                        value={stats?.rejectedReviews}
                        subtitle="Drafts dismissed by user"
                        icon="&#x1F6AB;"
                        variant="danger"
                        onClick={() => navigate("/reviews")}
                    />
                </div>
            </div>

            {/* Sentiment Breakdown */}
            <div className="stats-section">
                <h3 className="subheading">Sentiment Analysis</h3>
                <div className="stats-grid stats-grid-3">
                    <StatCard
                        title="Positive Reviews"
                        value={stats?.positiveReviews}
                        subtitle="4 &amp; 5-star customer feedback"
                        icon="&#x1F7E2;"
                        variant="success"
                    />
                    <StatCard
                        title="Neutral Reviews"
                        value={stats?.neutralReviews}
                        subtitle="3-star balanced feedback"
                        icon="&#x26AA;"
                        variant="default"
                    />
                    <StatCard
                        title="Negative Reviews"
                        value={stats?.negativeReviews}
                        subtitle="1 &amp; 2-star feedback"
                        icon="&#x1F534;"
                        variant="danger"
                    />
                </div>
            </div>

            {/* Reply Activity Stats */}
            <div className="stats-section">
                <h3 className="subheading">AI Reply Lifecycle</h3>
                <div className="stats-grid">
                    <StatCard
                        title="Total Replies Drafted"
                        value={stats?.totalReplies}
                        subtitle="Generated by AI service"
                        icon="&#x1F916;"
                        variant="primary"
                    />
                    <StatCard
                        title="Approved Replies"
                        value={stats?.approvedReplies}
                        subtitle="Validated and confirmed"
                        icon="&#x1F44D;"
                        variant="success"
                    />
                    <StatCard
                        title="Rejected Replies"
                        value={stats?.rejectedReplies}
                        subtitle="Declined by operator"
                        icon="&#x2715;"
                        variant="danger"
                    />
                    <StatCard
                        title="Published to Google"
                        value={stats?.publishedReplies}
                        subtitle="Live on Google Maps"
                        icon="&#x1F680;"
                        variant="info"
                    />
                </div>
            </div>

            {/* Quick Preview of Pending Reviews */}
            {recentPending.length > 0 && (
                <div className="dashboard-preview-section">
                    <div className="preview-header-row">
                        <div>
                            <h3 className="subheading">Pending Attention</h3>
                            <p className="text-muted">Top reviews currently waiting for decision</p>
                        </div>
                        <Link to="/pending" className="link-see-all">
                            View All ({stats?.pendingReviews || recentPending.length}) &#x2192;
                        </Link>
                    </div>

                    <div className="reviews-list">
                        {recentPending.map((review) => (
                            <ReviewCard
                                key={review._id}
                                review={review}
                                showReplyEditor={false}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
