import { useState } from "react";
import { StatusBadge, UrgencyBadge } from "./Badges";

// Google caps review replies at 4096 characters.
const MAX_REPLY_LENGTH = 4096;

const RISK_LABELS = {
    food_safety: "Food safety",
    allergy_medical: "Allergy / medical",
    harassment_discrimination: "Harassment / discrimination",
    fraud_legal: "Fraud / legal",
    threats_police: "Threats / police",
    unsafe_conditions: "Unsafe conditions",
    ai_unconfirmed_commitment: "AI draft offered unconfirmed compensation",
};

export function ReplyEditor({
    review,
    reply,
    onApprove,
    onReject,
    onRetryPublish,
    onReconcilePublish,
    readOnly = false,
}) {
    const defaultText = reply?.finalReply || reply?.draftReply || "";
    const [isEditing, setIsEditing] = useState(false);
    const [replyText, setReplyText] = useState(defaultText);
    const [actionLoading, setActionLoading] = useState(null); // 'approve' | 'reject' | null
    const [error, setError] = useState(null);

    const isPending = (reply?.status || "pending") === "pending";
    const publishFailed = isPending && Boolean(reply?.lastPublishError);
    const publishState = reply?.publishState || "none";
    const awaitingConfirmation = reply?.status === "approved" && ["sending", "accepted"].includes(publishState);
    const publishUnknown = reply?.status === "approved" && publishState === "unknown";
    const publishStale = awaitingConfirmation && reply?.publishStale === true;
    const publishHistory = Array.isArray(reply?.publishHistory) ? reply.publishHistory : [];
    const riskReasons = Array.isArray(reply?.riskReasons) ? reply.riskReasons : [];

    const handleReconcilePublish = async () => {
        if (!window.confirm(
            "Google never confirmed this attempt. Marking it as unknown does not resend anything. " +
            "Afterwards you can check Google and, if needed, retry, which sends the reply again. Continue?"
        )) {
            return;
        }
        setError(null);
        setActionLoading("reconcile");
        try {
            await onReconcilePublish(review._id);
        } catch (err) {
            setError(err.response?.data?.message || "Failed to update the publish status.");
        } finally {
            setActionLoading(null);
        }
    };

    const handleRetryPublish = async () => {
        if (!window.confirm(
            "The previous attempt may already have been published. Retrying replaces the reply on Google. Retry now?"
        )) {
            return;
        }
        setError(null);
        setActionLoading("retry");
        try {
            await onRetryPublish(review._id);
        } catch (err) {
            setError(err.response?.data?.message || "Failed to retry publishing.");
        } finally {
            setActionLoading(null);
        }
    };

    const handleApprove = async () => {
        setError(null);
        setActionLoading("approve");
        try {
            await onApprove(review._id, replyText);
            setIsEditing(false);
        } catch (err) {
            setError(err.response?.data?.message || "Failed to approve reply.");
        } finally {
            setActionLoading(null);
        }
    };

    const handleReject = async () => {
        if (!window.confirm("Are you sure you want to reject this reply?")) {
            return;
        }
        setError(null);
        setActionLoading("reject");
        try {
            await onReject(review._id);
            setIsEditing(false);
        } catch (err) {
            setError(err.response?.data?.message || "Failed to reject reply.");
        } finally {
            setActionLoading(null);
        }
    };

    return (
        <div className="reply-box">
            <div className="reply-header">
                <div className="reply-title-group">
                    <span className="reply-title">
                        {reply?.finalReply ? "Final Reply" : "AI Suggested Draft"}
                    </span>
                    {reply?.status && <StatusBadge status={reply.status} />}
                    {publishFailed && (
                        <span className="badge badge-status-rejected">Publish Failed</span>
                    )}
                    {awaitingConfirmation && (
                        <span className="badge badge-status-pending" title="Publish request to Google is in progress">
                            Publishing to Google
                        </span>
                    )}
                    {publishUnknown && (
                        <span className="badge badge-status-rejected">Publish Status Unknown</span>
                    )}
                    {reply?.needsHumanReview && (
                        <span className="badge badge-human-review">Needs Human Review</span>
                    )}
                    {reply?.urgency && <UrgencyBadge urgency={reply.urgency} />}
                </div>

                {isPending && !readOnly && !isEditing && (
                    <button
                        type="button"
                        className="btn-text"
                        onClick={() => setIsEditing(true)}
                    >
                        ✏️ Edit Draft
                    </button>
                )}
            </div>

            {riskReasons.length > 0 && (
                <div className="reply-error" role="note">
                    Flagged for review: {riskReasons.map((r) => RISK_LABELS[r] || r).join(", ")}.
                    Check the draft carefully before approving.
                </div>
            )}

            {publishFailed && (
                <div className="reply-error" role="status">
                    The last attempt to send this reply to Google failed ({reply.lastPublishError}).
                    It has not been published; approve again to retry.
                </div>
            )}

            {publishUnknown && (
                <div className="reply-error" role="status">
                    Google did not confirm the publish outcome ({reply.lastPublishError || "no response"}). The reply may
                    already be live. Check the review on Google before retrying.
                    {onRetryPublish && (
                        <div className="reply-action-bar">
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={handleRetryPublish}
                                disabled={actionLoading !== null}
                            >
                                {actionLoading === "retry" ? "Retrying..." : "Retry Publishing"}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {publishStale && (
                <div className="reply-error" role="status">
                    Google has not confirmed whether this reply was published. The outcome is
                    unknown: it may already be live. Marking it as unknown does not resend it.
                    {onReconcilePublish && (
                        <div className="reply-action-bar">
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={handleReconcilePublish}
                                disabled={actionLoading !== null}
                            >
                                {actionLoading === "reconcile" ? "Updating..." : "Mark Status Unknown"}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {error && <div className="reply-error" role="alert">{error}</div>}

            {publishHistory.length > 0 && (
                <details className="publish-history">
                    <summary>Publish history ({publishHistory.length})</summary>
                    <ol>
                        {publishHistory.map((entry, index) => (
                            <li key={`${entry.at}-${index}`}>
                                {entry.at ? new Date(entry.at).toLocaleString() : ""} · {entry.event.replace(/_/g, " ")}
                                {entry.attempt ? ` · attempt ${entry.attempt}` : ""}
                                {entry.detail ? ` · ${entry.detail}` : ""}
                            </li>
                        ))}
                    </ol>
                </details>
            )}

            {isEditing ? (
                <div className="reply-edit-area">
                    <textarea
                        className="reply-textarea"
                        rows={4}
                        value={replyText}
                        maxLength={MAX_REPLY_LENGTH}
                        aria-label="Reply text"
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Type your reply to this review..."
                    />
                    <div className="reply-edit-footer">
                        <span className="char-count">{replyText.length} / {MAX_REPLY_LENGTH} characters</span>
                        <div className="reply-btn-group">
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                    setReplyText(defaultText);
                                    setIsEditing(false);
                                }}
                                disabled={actionLoading !== null}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={handleApprove}
                                disabled={actionLoading !== null || !replyText.trim()}
                            >
                                {actionLoading === "approve" ? "Approving..." : "Save & Approve"}
                            </button>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="reply-content">
                    <p className="reply-text">
                        {replyText || <em className="text-muted">No draft reply generated.</em>}
                    </p>

                    {isPending && !readOnly && (
                        <div className="reply-action-bar">
                            <button
                                type="button"
                                className="btn btn-reject"
                                onClick={handleReject}
                                disabled={actionLoading !== null}
                            >
                                {actionLoading === "reject" ? "Rejecting..." : "✕ Reject"}
                            </button>
                            <button
                                type="button"
                                className="btn btn-approve"
                                onClick={handleApprove}
                                disabled={actionLoading !== null}
                            >
                                {actionLoading === "approve" ? "Approving..." : "✓ Approve Draft"}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
