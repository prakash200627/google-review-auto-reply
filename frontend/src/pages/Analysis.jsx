// Analysis Page – AI intelligence view using exact Dashboard visual language
import React, { useEffect, useState, useRef } from "react";
import { statsService } from "../services/api";
import { Loading } from "../components/Loading";
import { ErrorMessage } from "../components/ErrorMessage";

// Module-level cache – survives navigation, cleared on browser refresh
let cachedAnalysis = null;

// Insight topics to detect from real AI text – no fabrication, purely text-matching
const INSIGHT_TOPICS = [
  { key: "food",    icon: "🍽️", label: "Food & Dining",   keywords: ["food", "dish", "meal", "cuisine", "menu", "taste", "flavor", "flavour", "dining"] },
  { key: "service", icon: "👥", label: "Service",          keywords: ["service", "staff", "server", "waiter", "waitress", "attentive", "hospitality", "team"] },
  { key: "ambience",icon: "🏠", label: "Ambience",         keywords: ["ambience", "ambiance", "atmosphere", "decor", "setting", "environment", "vibe"] },
  { key: "wait",    icon: "⏱️", label: "Wait Times",       keywords: ["wait", "waiting", "slow", "delay", "time", "queue", "long"] },
  { key: "hygiene", icon: "🧼", label: "Hygiene & Safety", keywords: ["hygiene", "clean", "sanit", "safety", "health", "food safety"] },
  { key: "value",   icon: "💰", label: "Value for Money",  keywords: ["price", "value", "worth", "expensive", "affordable", "cheap", "cost"] },
];

function detectTopics(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return INSIGHT_TOPICS.filter(({ keywords }) =>
    keywords.some((kw) => lower.includes(kw))
  );
}

const Analysis = () => {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Guard against React StrictMode double-mount
  const didLoadRef = useRef(false);

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;

    const fetchData = async () => {
      try {
        if (cachedAnalysis) {
          setAnalysis(cachedAnalysis);
        } else {
          const res = await statsService.getAnalysis();
          if (res.success) {
            cachedAnalysis = res;
            setAnalysis(res);
          } else {
            setError(res.message || "Failed to load analysis");
          }
        }
      } catch (err) {
        setError(err.message || "Error loading analysis");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) return <Loading message="Loading analysis..." />;
  if (error) return <ErrorMessage message={error} />;

  const content =
    analysis?.analysis || analysis?.summary || "No analysis available.";

  const detectedTopics = detectTopics(content);

  return (
    <div className="dashboard-page">
      {/* Page header */}
      <div className="page-header-row">
        <div>
          <h2 className="section-title">🔍 Review Analysis</h2>
          <p className="section-subtitle">
            AI-powered insights from customer feedback.
          </p>
        </div>
      </div>

      {/* ── MAIN AI ANALYSIS CARD ────────────────────────── */}
      <div className="stats-section">
        <h3 className="subheading">AI Review Intelligence</h3>
        <div className="stat-card" style={{ padding: "1.5rem" }}>
          <div className="stat-card-header">
            <span className="stat-card-title">🤖 AI Review Intelligence</span>
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
            {content}
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

      {/* ── TOPIC INSIGHT CHIPS (only if detected in real text) ── */}
      {detectedTopics.length > 0 && (
        <div className="stats-section">
          <h3 className="subheading">Topics Detected in Analysis</h3>
          <div
            className="stats-grid"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            }}
          >
            {detectedTopics.map(({ key, icon, label }) => (
              <div key={key} className="stat-card">
                <div className="stat-card-header">
                  <span className="stat-card-title">{icon} {label}</span>
                  <div className="stat-card-icon">{icon}</div>
                </div>
                <p
                  className="stat-card-subtitle"
                  style={{ marginTop: "0.6rem" }}
                >
                  Mentioned in the AI analysis
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default Analysis;
