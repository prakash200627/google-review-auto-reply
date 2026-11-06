"use client";

import { useState } from "react";
import { sanitizeReplyDraft } from "@/lib/ai/sanitizeDraft";

export type PublishedReplyInfo = {
  comment: string;
  updateTime: string | null;
  state: string;
};

export function ReviewDraftControls({
  reviewId,
  starRating = null,
  initialPublishedReply,
  initialDraftText,
  initialDraftApproved,
  onPublished,
  onDraftSaved,
}: {
  reviewId: string;
  starRating?: number | null;
  initialPublishedReply?: PublishedReplyInfo | null;
  initialDraftText?: string | null;
  initialDraftApproved?: boolean;
  onPublished?: (reply: PublishedReplyInfo) => void;
  onDraftSaved?: (info: {
    draftText: string;
    draftApproved: boolean;
    draftStatus: string;
  }) => void;
}) {
  const hydrated = sanitizeReplyDraft(initialDraftText || "");
  const [draft, setDraft] = useState(hydrated);
  const [tone, setTone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hasDraft, setHasDraft] = useState(Boolean(hydrated.trim()));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [publishedReply, setPublishedReply] = useState<PublishedReplyInfo | null>(
    initialPublishedReply?.comment
      ? initialPublishedReply
      : null
  );
  const [approved, setApproved] = useState(Boolean(initialDraftApproved));
  const [saving, setSaving] = useState(false);

  const trimmedDraft = draft.trim();
  const canPublish = Boolean(trimmedDraft) && !loading && !publishing;

  async function generateDraft(forceRegenerate = false) {
    setLoading(true);
    setError(null);
    setSuccess(null);
    setCopied(false);
    try {
      const res = await fetch(
        `/api/reviews/${encodeURIComponent(reviewId)}/draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceRegenerate }),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        draft?: string;
        tone?: string;
        message?: string;
        isDraft?: boolean;
        code?: string;
        persisted?: boolean;
      };
      if (res.status === 409 && data.code === "draft_approved" && data.draft) {
        setDraft(sanitizeReplyDraft(data.draft));
        setHasDraft(true);
        setApproved(true);
        setError(
          data.message ||
            "An approved draft already exists. Confirm regenerate to replace it."
        );
        return;
      }
      if (!res.ok || !data.success || !data.draft) {
        setError(data.message || "Could not generate draft");
        return;
      }
      // Defense-in-depth: strip DEMO/TEST/SAMPLE suffixes client-side too.
      const cleaned = sanitizeReplyDraft(data.draft);
      setDraft(cleaned);
      setTone(data.tone || null);
      setHasDraft(true);
      setApproved(false);
      onDraftSaved?.({
        draftText: cleaned,
        draftApproved: false,
        draftStatus: "generated",
      });
      setSuccess(
        data.persisted
          ? "Draft saved on the server. Not sent to Google."
          : data.message || null
      );
    } catch {
      setError("Could not generate draft");
    } finally {
      setLoading(false);
    }
  }

  async function flagForReview() {
    const reason = window.prompt(
      "Short reason for staff investigation (not a fraud determination):"
    );
    if (!reason || reason.trim().length < 3) return;
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(
        `/api/reviews/${encodeURIComponent(reviewId)}/flag`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() }),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not flag review");
        return;
      }
      setSuccess(
        data.message ||
          "Flagged for staff investigation. Not sent to Google."
      );
    } catch {
      setError("Could not flag review");
    }
  }

  async function saveDraft(approve: boolean) {
    const cleaned = sanitizeReplyDraft(draft);
    if (!cleaned.trim()) {
      setError("Draft text cannot be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(
        `/api/reviews/${encodeURIComponent(reviewId)}/draft`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftText: cleaned, approve }),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        draftApproved?: boolean;
        draftStatus?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not save draft");
        return;
      }
      setDraft(cleaned);
      setApproved(Boolean(data.draftApproved));
      onDraftSaved?.({
        draftText: cleaned,
        draftApproved: Boolean(data.draftApproved),
        draftStatus:
          data.draftStatus || (approve ? "approved" : "edited"),
      });
      setSuccess(data.message || (approve ? "Draft approved." : "Draft saved."));
    } catch {
      setError("Could not save draft");
    } finally {
      setSaving(false);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  function openPublishConfirm() {
    setError(null);
    setSuccess(null);
    const cleaned = sanitizeReplyDraft(draft);
    if (cleaned !== draft) {
      setDraft(cleaned);
    }
    if (!cleaned.trim()) {
      setError("Reply text cannot be empty.");
      return;
    }
    setConfirmOpen(true);
  }

  async function confirmPublish() {
    const comment = sanitizeReplyDraft(draft).trim();
    if (!comment || publishing) return;
    setPublishing(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(
        `/api/reviews/${encodeURIComponent(reviewId)}/reply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment,
            confirmReplace: Boolean(publishedReply?.comment),
          }),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        published?: boolean;
        message?: string;
        code?: string;
        existingReply?: string;
        reply?: {
          comment?: string;
          updateTime?: string | null;
          state?: string;
        };
      };

      if (!res.ok || !data.success || !data.published || !data.reply?.comment) {
        if (data.code === "needs_replace_confirmation" && data.existingReply) {
          setPublishedReply({
            comment: data.existingReply,
            updateTime: null,
            state: "",
          });
          setError(
            data.message ||
              "This review already has a published reply. Confirm again to replace it."
          );
          return;
        }
        setError(data.message || "Publish failed");
        return;
      }

      const next: PublishedReplyInfo = {
        comment: data.reply.comment,
        updateTime: data.reply.updateTime ?? null,
        state: data.reply.state || "",
      };
      setPublishedReply(next);
      onPublished?.(next);
      setSuccess(
        data.message || "Reply published to Google Business Profile."
      );
      setConfirmOpen(false);
    } catch {
      setError("Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-dashed border-zinc-200 bg-zinc-50/80 p-3">
      {starRating === 1 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          <p className="font-semibold">One-star review — high priority</p>
          <p className="mt-1">
            Sync may open an internal escalation flag. AI draft and publish remain
            separate manual steps. Auto-publish never sends 1★ replies. Reporting
            to Google is not performed by this app.
          </p>
        </div>
      ) : null}
      {publishedReply?.comment ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50/80 px-3 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-800">
            Published on Google
            {publishedReply.state ? ` · ${publishedReply.state}` : ""}
            {publishedReply.updateTime
              ? ` · ${new Date(publishedReply.updateTime).toLocaleString()}`
              : ""}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-emerald-950">
            {publishedReply.comment}
          </p>
          <p className="mt-1 text-xs text-emerald-900/80">
            Publishing again will replace this public reply after you confirm.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          AI reply draft
          {tone ? ` · ${tone}` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              void generateDraft(approved)
            }
            disabled={loading || publishing || saving}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading
              ? "Generating…"
              : hasDraft
                ? approved
                  ? "Force regenerate"
                  : "Regenerate"
                : "Generate draft"}
          </button>
          {hasDraft && (
            <>
              <button
                type="button"
                onClick={() => void saveDraft(false)}
                disabled={!draft || loading || publishing || saving}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save draft"}
              </button>
              <button
                type="button"
                onClick={() => void saveDraft(true)}
                disabled={!draft || loading || publishing || saving}
                className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-900 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {approved ? "Approved" : "Approve draft"}
              </button>
              <button
                type="button"
                onClick={() => void copyDraft()}
                disabled={!draft || loading || publishing}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={openPublishConfirm}
                disabled={!canPublish}
                className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-800 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Publish reply
              </button>
              <button
                type="button"
                onClick={() => void flagForReview()}
                disabled={loading || publishing || saving}
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Flag for staff
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-md bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800">
          {success}
        </p>
      )}

      {hasDraft && (
        <>
          <p className="text-xs text-amber-800">
            Draft only until you publish. Publishing sends a real public reply
            to Google Business Profile.
          </p>
          <textarea
            className="min-h-[96px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSuccess(null);
            }}
            disabled={publishing}
            aria-label="Editable AI reply draft"
          />
        </>
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`publish-confirm-${reviewId}`}
        >
          <div className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white p-4 shadow-lg">
            <h3
              id={`publish-confirm-${reviewId}`}
              className="text-base font-semibold text-zinc-900"
            >
              Publish this reply to Google?
            </h3>
            <p className="mt-2 text-sm text-zinc-600">
              This sends a <span className="font-medium">real public reply</span>{" "}
              to the Google Business Profile review. It is not a draft preview.
              {publishedReply?.comment
                ? " An existing published reply will be replaced."
                : ""}
            </p>
            <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Exact text that will be sent
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-900">
                {trimmedDraft || "(empty)"}
              </p>
            </div>
            {publishedReply?.comment ? (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-800">
                  Existing published reply
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-amber-950">
                  {publishedReply.comment}
                </p>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={publishing}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmPublish()}
                disabled={!trimmedDraft || publishing}
                className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {publishing
                  ? "Publishing…"
                  : publishedReply?.comment
                    ? "Replace reply on Google"
                    : "Confirm publish to Google"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
