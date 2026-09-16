import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { statsService, reviewsService } from "../services/api";
import { StatCard } from "../components/StatCard";
import { ReviewCard } from "../components/ReviewCard";
import { Loading } from "../components/Loading";
import { ErrorMessage } from "../components/ErrorMessage";
import { useAuth } from "../context/AuthContext";

// In-memory cache for AI analysis to eliminate redundant requests across client navigation
let cachedAnalysis = null;

export function Dashboard() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const [stats, setStats] = useState(null);
    const [recentPending, setRecentPending] = useState([]);
    const [analysis, setAnalysis] = useState(() => cachedAnalysis);
    const [analysisLoading, setAnalysisLoading] = useState(() => !cachedAnalysis);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);

    const initialLoadFired = useRef(false);

    // Fast loading of core stats & pending reviews (instant MongoDB queries)
    const loadCoreStats = async () => {
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
            console.error("Error loading core dashboard stats:", err);
            if (!stats) {
                setError(
                    err.response?.data?.message ||
                    "Failed to load dashboard statistics. Please verify backend connection."
                );
            }
        }
    };

    // Dedicated, non-blocking fetch for AI analysis (strictly on initial load or explicit user refresh)
    const loadAnalysisData = async () => {
        setAnalysisLoading(true);
        try {
            const analysisData = await statsService.getAnalysis();
            console.log("DASHBOARD ANALYSIS RESPONSE:", analysisData);
            if (analysisData && analysisData.success) {
                cachedAnalysis = analysisData;
                setAnalysis((prev) => {
                    // Never overwrite a successful OpenAI response with fallback data
                    if (prev?.usedOpenAI && !analysisData.usedOpenAI) {
                        return prev;
                    }
                    return analysisData;
                });
            }
        } catch (err) {
            console.error("DASHBOARD ANALYSIS ERROR:", err);
        } finally {
            setAnalysisLoading(false);
        }
    };

    // Refresh all data in-place ONLY when the user explicitly clicks "Refresh Data"
    const handleRefresh = async () => {
        setRefreshing(true);
        await Promise.allSettled([loadCoreStats(), loadAnalysisData()]);
        setRefreshing(false);
    };

    useEffect(() => {
        if (initialLoadFired.current) return;
        initialLoadFired.current = true;

        const initDashboard = async () => {
            setError(null);
            // Fetch AI analysis only if not already loaded; core stats always load fast
            if (!cachedAnalysis) {
                loadAnalysisData();
            }
            await loadCoreStats();
            setLoading(false);
        };

        initDashboard();
    }, []);

    if (loading && !stats) {
        return <Loading message="Loading dashboard statistics..." />;
    }

    if (error && !stats) {
        return <ErrorMessage message={error} onRetry={handleRefresh} />;
    }

    return (
        <div className="dashboard-page">
            {/* Header Banner */}
            <div className="page-header-row">
                <div>
                    <h2 className="section-title">
                        Welcome back, {user?.name || "Organization"}! 👋
                    </h2>
                    <p className="section-subtitle">
                        Here is an overview of your Google review metrics, response drafts, and pending approvals.
                    </p>
                </div>
                <button
                    type="button"
                    className="btn btn-secondary btn-refresh"
                    onClick={handleRefresh}
                    disabled={refreshing}
                >
                    {refreshing ? "🔄 Refreshing..." : "🔄 Refresh Data"}
                </button>
            </div>

            {/* AI Review Summary & Analysis - At the TOP */}
            <div className="stats-section">
                <h3 className="subheading">AI Review Summary &amp; Analysis</h3>
                <div className="stat-card" style={{ padding: "1.25rem" }}>
                    <div className="stat-card-header">
                        <span className="stat-card-title">🧠 Executive Intelligence Summary</span>
                        {analysisLoading && !analysis ? (
                            <span className="badge badge-status-pending">
                                <span className="badge-dot" /> Generating AI Insights...
                            </span>
                        ) : (
                            <span
                                className={
                                    analysis?.usedOpenAI
                                        ? "badge badge-status-approved"
                                        : "badge badge-status-neutral"
                                }
                            >
                                {analysis?.usedOpenAI
                                    ? "✨ Powered by OpenAI"
                                    : "🤖 Automated Summary"}
                            </span>
                        )}
                    </div>
                    <div
                        style={{
                            marginTop: "0.75rem",
                            fontSize: "0.92rem",
                            lineHeight: "1.6",
                            color: "var(--text-primary)",
                        }}
                    >
                        <p style={{ margin: 0 }}>
                            {analysisLoading && !analysis
                                ? "Analyzing recent Google reviews and customer sentiment with AI..."
                                : analysis?.analysis ||
                                  analysis?.summary ||
                                  (typeof analysis === "string"
                                      ? analysis
                                      : "No review summary available.")}
                        </p>
                        <div
                            style={{
                                marginTop: "0.75rem",
                                fontSize: "0.8rem",
                                color: "var(--text-muted)",
                            }}
                        >
                            Engine:{" "}
                            {analysisLoading && !analysis
                                ? "OpenAI gpt-4o-mini (Processing...)"
                                : analysis?.usedOpenAI
                                ? "OpenAI gpt-4o-mini"
                                : "System Sentiment Analyzer"}
                        </div>
                    </div>
                </div>
            </div>

            {/* Attention Alert if pending reviews exist */}
            {stats && stats.pendingReviews > 0 && (
                <div className="alert-banner-inbox">
                    <div className="alert-banner-content">
                        <span className="alert-banner-icon">⚡</span>
                        <div>
                            <strong>
                                {stats.pendingReviews} review
                                {stats.pendingReviews > 1 ? "s" : ""} waiting for your response!
                            </strong>
                            <p>AI draft replies are ready for review, edit, or approval.</p>
                        </div>
                    </div>
                    <Link to="/pending" className="btn btn-primary btn-sm">
                        Go to Inbox →
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
                        icon="⭐"
                        variant="primary"
                        onClick={() => navigate("/reviews")}
                    />
                    <StatCard
                        title="Pending Reviews"
                        value={stats?.pendingReviews}
                        subtitle="Awaiting approval / action"
                        icon="⏳"
                        variant="warning"
                        onClick={() => navigate("/pending")}
                    />
                    <StatCard
                        title="Replied Reviews"
                        value={stats?.repliedReviews}
                        subtitle="Replies approved / handled"
                        icon="✅"
                        variant="success"
                        onClick={() => navigate("/reviews")}
                    />
                    <StatCard
                        title="Rejected Reviews"
                        value={stats?.rejectedReviews}
                        subtitle="Drafts dismissed by user"
                        icon="🚫"
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
                        icon="🟢"
                        variant="success"
                    />
                    <StatCard
                        title="Neutral Reviews"
                        value={stats?.neutralReviews}
                        subtitle="3-star balanced feedback"
                        icon="⚪"
                        variant="default"
                    />
                    <StatCard
                        title="Negative Reviews"
                        value={stats?.negativeReviews}
                        subtitle="1 &amp; 2-star feedback"
                        icon="🔴"
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
                        icon="🤖"
                        variant="primary"
                    />
                    <StatCard
                        title="Approved Replies"
                        value={stats?.approvedReplies}
                        subtitle="Validated and confirmed"
                        icon="👍"
                        variant="success"
                    />
                    <StatCard
                        title="Rejected Replies"
                        value={stats?.rejectedReplies}
                        subtitle="Declined by operator"
                        icon="✕"
                        variant="danger"
                    />
                    <StatCard
                        title="Published to Google"
                        value={stats?.publishedReplies}
                        subtitle="Live on Google Maps"
                        icon="🚀"
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
                            View All ({stats?.pendingReviews || recentPending.length}) →
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
