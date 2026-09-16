// Summary Page – business-level overview using exact Dashboard visual language
import React, { useEffect, useState, useRef } from "react";
import { statsService } from "../services/api";
import { Loading } from "../components/Loading";
import { ErrorMessage } from "../components/ErrorMessage";

// Module-level cache – survives navigation, cleared on browser refresh
let cachedSummary = null;
let cachedStats = null;

export function Summary() {
  const [analysis, setAnalysis] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Guard against React StrictMode double-mount
  const didLoadRef = useRef(false);

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;

    const fetchData = async () => {
      try {
        if (cachedSummary && cachedStats) {
          setAnalysis(cachedSummary);
          setStats(cachedStats);
        } else {
          const [analysisRes, statsRes] = await Promise.all([
            statsService.getAnalysis(),
            statsService.getStats(),
          ]);
          if (analysisRes.success) {
            cachedSummary = analysisRes;
            setAnalysis(analysisRes);
          } else {
            setError(analysisRes.message || "Failed to load summary");
          }
          if (statsRes.success) {
            cachedStats = statsRes.stats;
            setStats(statsRes.stats);
          } else {
            setError(statsRes.message || "Failed to load stats");
          }
        }
      } catch (err) {
        setError(err.message || "Error loading summary");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) return <Loading message="Loading summary..." />;
  if (error) return <ErrorMessage message={error} />;

  // Derive sentiment label and breakdown from real stats
  const positive = stats?.positiveReviews ?? 0;
  const neutral = stats?.neutralReviews ?? 0;
  const negative = stats?.negativeReviews ?? 0;
  const total = positive + neutral + negative;

  let sentimentLabel = "No data";
  let sentimentBadgeClass = "badge badge-status-neutral";
  let sentimentBreakdown = "";

  if (total > 0) {
    const posPct = Math.round((positive / total) * 100);
    const neuPct = Math.round((neutral / total) * 100);
    const negPct = Math.round((negative / total) * 100);
    sentimentBreakdown = `${posPct}% positive · ${neuPct}% neutral · ${negPct}% negative`;

    if (posPct >= 60) {
      sentimentLabel = "Positive";
      sentimentBadgeClass = "badge badge-sentiment-positive";
    } else if (negPct >= 60) {
      sentimentLabel = "Negative";
      sentimentBadgeClass = "badge badge-sentiment-negative";
    } else {
      sentimentLabel = "Mixed";
      sentimentBadgeClass = "badge badge-status-neutral";
    }
  }

  const aiText =
    analysis?.analysis || analysis?.summary || "No summary available.";

  // ── Key Takeaway: built dynamically from AI text + stats ──────────────────
  // Detect praised topics from the AI text
  const PRAISE_GROUPS = [
    { label: "food",         kws: ["food", "dish", "meal", "cuisine", "menu", "taste", "flavor", "flavour", "dining"] },
    { label: "service",      kws: ["service", "staff", "server", "waiter", "waitress", "attentive", "hospitality", "friendly", "team"] },
    { label: "atmosphere",   kws: ["ambience", "ambiance", "atmosphere", "decor", "setting", "environment", "vibe", "welcoming"] },
    { label: "value",        kws: ["value", "affordable", "worth", "reasonable", "price"] },
  ];
  const CONCERN_GROUPS = [
    { label: "wait times",       kws: ["wait", "waiting", "slow", "delay", "long", "queue"] },
    { label: "food safety",      kws: ["hygiene", "sanit", "food safety", "health", "cleanliness"] },
    { label: "consistency",      kws: ["inconsistent", "inconsistency", "sometimes", "occasionally", "vary", "varies"] },
    { label: "pricing",          kws: ["expensive", "overpriced", "costly", "pricey"] },
    { label: "noise",            kws: ["noise", "noisy", "loud"] },
  ];

  const lower = aiText.toLowerCase();
  const praised  = PRAISE_GROUPS.filter(g => g.kws.some(k => lower.includes(k))).map(g => g.label);
  const concerns = CONCERN_GROUPS.filter(g => g.kws.some(k => lower.includes(k))).map(g => g.label);

  let keyTakeaway = "";
  const joinLabels = (arr) =>
    arr.length === 1
      ? arr[0]
      : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];

  if (praised.length > 0 && concerns.length > 0) {
    keyTakeaway =
      `Customers consistently praise the ${joinLabels(praised)}, while ${joinLabels(concerns)} ` +
      `stand out as the main areas requiring attention.`;
  } else if (praised.length > 0) {
    const posPct = total > 0 ? Math.round((positive / total) * 100) : null;
    keyTakeaway = `Customer feedback is largely positive, with ${joinLabels(praised)} receiving consistent recognition` +
      (posPct !== null ? ` (${posPct}% of reviews positive).` : ".");
  } else if (concerns.length > 0) {
    keyTakeaway = `Key areas to focus on include ${joinLabels(concerns)} based on recurring customer feedback.`;
  } else {
    // Fallback: use second sentence of AI text so it doesn't duplicate the first
    const sentences = aiText.match(/[^.!?]+[.!?]+/g) || [];
    keyTakeaway = sentences[1]?.trim() || sentences[0]?.trim() || aiText;
  }

  return (
    <div className="dashboard-page">
      {/* Page header */}
      <div className="page-header-row">
        <div>
          <h2 className="section-title">📋 Review Summary</h2>
          <p className="section-subtitle">
            Understand the overall voice of your customers.
          </p>
        </div>
      </div>

      {/* ── MAIN AI SUMMARY CARD ─────────────────────────── */}
      <div className="stats-section">
        <h3 className="subheading">AI Overview</h3>
        <div className="stat-card" style={{ padding: "1.5rem" }}>
          <div className="stat-card-header">
            <span className="stat-card-title">🧠 Overall Review Summary</span>
            <span
              className={
                analysis?.usedOpenAI
                  ? "badge badge-status-approved"
                  : "badge badge-status-neutral"
              }
            >
              {analysis?.usedOpenAI ? "✨ Powered by OpenAI" : "🤖 Automated Summary"}
            </span>
          </div>
          <p
            style={{
              marginTop: "1rem",
              fontSize: "0.95rem",
              lineHeight: "1.75",
              color: "var(--text-primary)",
            }}
          >
            {aiText}
          </p>
          <div
            style={{
              marginTop: "0.75rem",
              fontSize: "0.78rem",
              color: "var(--text-muted)",
            }}
          >
            Engine:{" "}
            {analysis?.usedOpenAI
              ? "OpenAI gpt-4o-mini"
              : "System Sentiment Analyzer"}
          </div>
        </div>
      </div>

      {/* ── TWO-COLUMN INSIGHT CARDS ─────────────────────── */}
      <div className="stats-section">
        <h3 className="subheading">Insights</h3>
        <div className="stats-grid stats-grid-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>

          {/* Overall Sentiment */}
          <div className="stat-card">
            <div className="stat-card-header">
              <span className="stat-card-title">💬 Overall Customer Sentiment</span>
              <div className="stat-card-icon">💬</div>
            </div>
            <div className="stat-card-body" style={{ marginTop: "0.75rem" }}>
              <span className={sentimentBadgeClass} style={{ fontSize: "0.82rem", marginBottom: "0.5rem", alignSelf: "flex-start" }}>
                {sentimentLabel}
              </span>
              {sentimentBreakdown && (
                <p className="stat-card-subtitle" style={{ marginTop: "0.4rem" }}>
                  {sentimentBreakdown}
                  {total > 0 && (
                    <> &nbsp;·&nbsp; {total} reviews analysed</>
                  )}
                </p>
              )}
            </div>
          </div>

          {/* Key Takeaway */}
          <div className="stat-card">
            <div className="stat-card-header">
              <span className="stat-card-title">📌 Key Takeaway</span>
              <div className="stat-card-icon">📌</div>
            </div>
            <div className="stat-card-body" style={{ marginTop: "0.75rem" }}>
              <p
                style={{
                  fontSize: "0.88rem",
                  lineHeight: "1.65",
                  color: "var(--text-secondary)",
                }}
              >
                {keyTakeaway}
              </p>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
