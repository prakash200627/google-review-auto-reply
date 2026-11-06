"use client";

import { useEffect, useState } from "react";
import {
  PERMANENT_DELETE_CONFIRM_PHRASE,
  type PermanentDeletePreview,
} from "@/lib/business/permanentDeleteTypes";

type Props = {
  businessId: string;
  businessName: string;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onDeleted: (message: string) => void;
  onError: (message: string) => void;
};

export function AdminPermanentDeleteDialog({
  businessId,
  businessName,
  open,
  busy,
  onClose,
  onDeleted,
  onError,
}: Props) {
  const [preview, setPreview] = useState<PermanentDeletePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmName, setConfirmName] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [secondConfirm, setSecondConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !businessId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/businesses/${encodeURIComponent(businessId)}/permanent-delete`
        );
        const data = (await res.json()) as {
          success?: boolean;
          preview?: PermanentDeletePreview;
          message?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.success || !data.preview) {
          setLoadError(data.message || "Could not load deletion impact.");
          setLoading(false);
          return;
        }
        setPreview(data.preview);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setLoadError("Could not load deletion impact.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, businessId]);

  if (!open) return null;

  const nameOk = confirmName === (preview?.name || businessName);
  const phraseOk = confirmPhrase.trim() === PERMANENT_DELETE_CONFIRM_PHRASE;
  const canSubmit =
    Boolean(preview?.canDelete) &&
    nameOk &&
    phraseOk &&
    secondConfirm &&
    !submitting &&
    !busy &&
    !loading;

  async function submit(resume = false) {
    if (!preview) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/businesses/${encodeURIComponent(businessId)}/permanent-delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmName,
            confirmPermanentDelete: secondConfirm === true,
            confirmPhrase: confirmPhrase.trim(),
            resume,
          }),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        code?: string;
      };
      if (!res.ok || !data.success) {
        if (data.code === "deletion_in_progress") {
          onError(
            data.message ||
              "Deletion already in progress. Use Resume if you are recovering a failed attempt."
          );
          return;
        }
        onError(data.message || "Permanent deletion failed.");
        return;
      }
      onDeleted(data.message || "Business permanently deleted.");
      onClose();
    } catch {
      onError("Permanent deletion failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const c = preview?.counts;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="permanent-delete-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-red-300 bg-white p-5 shadow-lg">
        <h2
          id="permanent-delete-title"
          className="text-lg font-semibold tracking-tight text-red-900"
        >
          Permanent delete — irreversible
        </h2>
        <p className="mt-1 text-sm text-red-800">
          This permanently removes the TRONX business record and business-scoped
          data. Google Business Profile locations, reviews, and replies on Google
          are never deleted. Archive is reversible; this is not.
        </p>

        {loading && (
          <p className="mt-4 text-sm text-zinc-600">Loading impact…</p>
        )}
        {loadError && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
            {loadError}
          </p>
        )}

        {preview && (
          <div className="mt-4 space-y-3 text-sm text-zinc-800">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-2 gap-y-1">
              <dt className="font-medium text-zinc-600">Name</dt>
              <dd className="font-semibold">{preview.name}</dd>
              <dt className="font-medium text-zinc-600">Business ID</dt>
              <dd className="font-mono text-xs break-all">{preview.businessId}</dd>
              <dt className="font-medium text-zinc-600">Status</dt>
              <dd>{preview.status}</dd>
              <dt className="font-medium text-zinc-600">Owners</dt>
              <dd>
                {preview.owners.length === 0
                  ? "none"
                  : preview.owners
                      .map(
                        (o) =>
                          `${o.email}${
                            o.willDeleteAccount
                              ? " (account will be deleted)"
                              : o.otherBusinessCount > 0
                                ? ` (kept — ${o.otherBusinessCount} other business(es))`
                                : ""
                          }`
                      )
                      .join("; ")}
              </dd>
              <dt className="font-medium text-zinc-600">Locations</dt>
              <dd>{c?.locationsAssigned ?? 0} assigned (docs retained, unassigned)</dd>
              <dt className="font-medium text-zinc-600">Reviews</dt>
              <dd>
                {c?.reviewsLinked ?? 0} linked · {c?.draftsPresent ?? 0} with
                drafts (docs retained; drafts cleared)
              </dd>
              <dt className="font-medium text-zinc-600">Auto-publish</dt>
              <dd>
                {c?.autoPublishJobs ?? 0} job(s) · {c?.autoPublishOpen ?? 0} open
                (deleted)
              </dd>
              <dt className="font-medium text-zinc-600">SEO</dt>
              <dd>
                {c?.seoKeywords ?? 0} keyword(s) · {c?.seoRankings ?? 0} ranking(s)
              </dd>
              <dt className="font-medium text-zinc-600">GMB jobs</dt>
              <dd>{c?.gmbServiceJobs ?? 0}</dd>
              <dt className="font-medium text-zinc-600">Flags</dt>
              <dd>{c?.fakeReviewFlags ?? 0}</dd>
              <dt className="font-medium text-zinc-600">Reports</dt>
              <dd>No stored report documents (derived at read time)</dd>
              <dt className="font-medium text-zinc-600">Retained</dt>
              <dd>
                {c?.manualPaymentsRetained ?? 0} payment(s) ·{" "}
                {c?.auditEventsRetained ?? 0} audit event(s) · org &amp; platform
                Google connection
              </dd>
            </dl>

            {preview.blockers.length > 0 && (
              <ul className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950">
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}

            {preview.deletionInProgress && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950">
                A previous deletion attempt left this business locked. Confirm
                again and use Resume to finish idempotent cleanup.
              </p>
            )}

            <label className="block">
              <span className="font-medium">
                Type the business name exactly to continue
              </span>
              <input
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={submitting || busy}
                aria-label="Confirm business name"
              />
            </label>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={secondConfirm}
                onChange={(e) => setSecondConfirm(e.target.checked)}
                disabled={submitting || busy}
              />
              <span>
                I understand this is irreversible and that UI confirmation alone
                does not authorize deletion — the server will re-verify Super
                Admin access and these confirmations.
              </span>
            </label>

            <label className="block">
              <span className="font-medium">
                Type {PERMANENT_DELETE_CONFIRM_PHRASE} to confirm
              </span>
              <input
                className="mt-1 w-full rounded-md border border-red-300 px-3 py-2 font-mono text-sm"
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={submitting || busy}
                aria-label="Confirm permanent delete phrase"
              />
            </label>
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          {preview?.deletionInProgress && (
            <button
              type="button"
              className="rounded-md border border-amber-500 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-950 hover:bg-amber-100 disabled:opacity-50"
              disabled={!canSubmit}
              onClick={() => void submit(true)}
            >
              {submitting ? "Resuming…" : "Resume locked deletion"}
            </button>
          )}
          <button
            type="button"
            className="rounded-md border border-red-700 bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSubmit || Boolean(preview?.deletionInProgress)}
            onClick={() => void submit(false)}
          >
            {submitting ? "Deleting…" : "Permanently delete business"}
          </button>
        </div>
      </div>
    </div>
  );
}
