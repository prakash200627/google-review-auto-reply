import { useState } from "react";
import { StatusBadge, UrgencyBadge } from "./Badges";

export function ReplyEditor({
    review,
    reply,
    onApprove,
    onReject,
    readOnly = false,
}) {
    const defaultText = reply?.finalReply || reply?.draftReply || "";
    const [isEditing, setIsEditing] = useState(false);
    const [replyText, setReplyText] = useState(defaultText);
    const [actionLoading, setActionLoading] = useState(null); // 'approve' | 'reject' | null
    const [error, setError] = useState(null);

    const isPending = (reply?.status || "pending") === "pending";

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

            {error && <div className="reply-error">{error}</div>}

            {isEditing ? (
                <div className="reply-edit-area">
                    <textarea
                        className="reply-textarea"
                        rows={4}
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Type your reply to this review..."
                    />
                    <div className="reply-edit-footer">
                        <span className="char-count">{replyText.length} characters</span>
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
