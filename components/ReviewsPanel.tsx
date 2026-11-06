"use client";

import { useState } from "react";
import { ReviewDraftControls } from "@/components/ReviewDraftControls";
import type { SyncedLocationSummary } from "@/lib/google/syncLocations";
import type { SafeReviewSummary } from "@/lib/google/syncReviews";

type LoadState = "idle" | "loading" | "ready" | "error";

export function ReviewsPanel({
  initialLocations,
  initialError,
  canDiscoverLocations = false,
}: {
  initialLocations: SyncedLocationSummary[];
  initialError?: string | null;
  /** Super Admin only — org-wide Google discovery/upsert. */
  canDiscoverLocations?: boolean;
}) {
  const [locations, setLocations] =
    useState<SyncedLocationSummary[]>(initialLocations);
  const [selectedId, setSelectedId] = useState("");
  const [reviews, setReviews] = useState<SafeReviewSummary[]>([]);
  const [locationsState, setLocationsState] = useState<LoadState>("ready");
  const [reviewsState, setReviewsState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [info, setInfo] = useState<string | null>(null);
  const [showUnrepliedOnly, setShowUnrepliedOnly] = useState(false);

  const visibleReviews = showUnrepliedOnly
    ? reviews.filter((r) => !r.replyComment)
    : reviews;
  const unrepliedCount = reviews.filter((r) => !r.replyComment).length;

  async function discoverLocations() {
    setLocationsState("loading");
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/google/locations", { method: "POST" });
      const data = (await res.json()) as {
        success?: boolean;
        locations?: SyncedLocationSummary[];
        discovered?: number;
        message?: string;
        code?: string;
      };
      if (!res.ok || !data.success) {
        setLocationsState("error");
        setError(data.message || "Location discovery failed");
        return;
      }
      setLocations(data.locations || []);
      setLocationsState("ready");
      setInfo(
        `Discovered ${data.discovered ?? 0} location(s) from Google (read-only).`
      );
      if (data.locations?.length === 1) {
        setSelectedId(data.locations[0].id);
      }
    } catch {
      setLocationsState("error");
      setError("Location discovery failed");
    }
  }

  async function loadStoredReviews(locationId: string) {
    if (!locationId) {
      setReviews([]);
      return;
    }
    setReviewsState("loading");
    setError(null);
    try {
      const res = await fetch(
        `/api/google/locations/${encodeURIComponent(locationId)}/reviews`
      );
      const data = (await res.json()) as {
        success?: boolean;
        reviews?: SafeReviewSummary[];
        message?: string;
      };
      if (!res.ok || !data.success) {
        setReviews([]);
        setReviewsState("error");
        setError(data.message || "Could not load reviews");
        return;
      }
      setReviews(data.reviews || []);
      setReviewsState("ready");
    } catch {
      setReviewsState("error");
      setError("Could not load reviews");
    }
  }

  async function syncReviews() {
    if (!selectedId) return;
    setReviewsState("loading");
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(
        `/api/google/locations/${encodeURIComponent(selectedId)}/reviews`,
        { method: "POST" }
      );
      const data = (await res.json()) as {
        success?: boolean;
        reviews?: SafeReviewSummary[];
        upserted?: number;
        totalReviewCount?: number | null;
        message?: string;
        code?: string;
      };
      if (!res.ok || !data.success) {
        setReviews([]);
        setReviewsState("error");
        setError(data.message || "Review retrieval failed");
        return;
      }
      setReviews(data.reviews || []);
      setReviewsState("ready");
      const total =
        typeof data.totalReviewCount === "number"
          ? ` Google reported ${data.totalReviewCount} total.`
          : "";
      setInfo(
        `Retrieved and stored ${data.upserted ?? 0} review(s).${total} No replies were published.`
      );
    } catch {
      setReviewsState("error");
      setError("Review retrieval failed");
    }
  }

  function onSelectLocation(id: string) {
    setSelectedId(id);
    setInfo(null);
    void loadStoredReviews(id);
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Locations</h2>
            <p className="mt-1 text-sm text-zinc-600">
              {canDiscoverLocations
                ? "Super Admins can discover Business Profile locations for the connected Google account, then select one to view reviews."
                : "Business owners only see locations already assigned by a Super Admin. Discovery and org-wide upserts are Super Admin only."}{" "}
              Read-only discovery — replies are never created or changed here.
            </p>
          </div>
          {canDiscoverLocations ? (
            <button
              type="button"
              onClick={() => void discoverLocations()}
              disabled={locationsState === "loading"}
              className="inline-flex rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {locationsState === "loading" ? "Working…" : "Discover locations"}
            </button>
          ) : null}
        </div>

        {locations.length === 0 && locationsState === "ready" && (
          <p className="mt-4 text-sm text-zinc-600">
            No locations loaded yet. Sign in under{" "}
            <a className="underline" href="/login">
              Login
            </a>
            . Super Admins connect Google under{" "}
            <a className="underline" href="/gmb">
              GMB → Connection
            </a>
            {canDiscoverLocations
              ? ", then discover locations under GMB → Locations."
              : ". Ask a Super Admin to discover locations and assign them to your business."}
          </p>
        )}

        {locations.length > 0 && (
          <label className="mt-4 block text-sm">
            <span className="font-medium text-zinc-800">Location</span>
            <select
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
              value={selectedId}
              onChange={(e) => onSelectLocation(e.target.value)}
            >
              <option value="">Select a location…</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.title || loc.googleLocationName}
                  {loc.address ? ` — ${loc.address}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Fetch &amp; store reviews
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Explicitly retrieve reviews from Google for this location and store
              them in TRONX. Nothing runs on page load. Day-to-day inbox, drafts,
              and publishing live under ORM → Reviews. Publishing still requires
              an explicit confirmation there (or below).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void syncReviews()}
            disabled={!selectedId || reviewsState === "loading"}
            className="inline-flex rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reviewsState === "loading" ? "Loading…" : "Fetch reviews"}
          </button>
        </div>

        {selectedId && reviewsState === "ready" && reviews.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <p className="text-zinc-600">
              {unrepliedCount} without a reply · {reviews.length - unrepliedCount}{" "}
              published
            </p>
            <label className="inline-flex items-center gap-2 text-zinc-800">
              <input
                type="checkbox"
                checked={showUnrepliedOnly}
                onChange={(e) => setShowUnrepliedOnly(e.target.checked)}
              />
              Show unreplied only
            </label>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        {info && (
          <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {info}
          </p>
        )}

        {!selectedId && (
          <p className="mt-4 text-sm text-zinc-600">
            Select a location to view reviews.
          </p>
        )}

        {selectedId && reviews.length === 0 && reviewsState === "ready" && (
          <p className="mt-4 text-sm text-zinc-600">
            No reviews stored for this location yet. Use Fetch reviews to
            retrieve them from Google.
          </p>
        )}

        {selectedId &&
          reviews.length > 0 &&
          visibleReviews.length === 0 &&
          showUnrepliedOnly && (
            <p className="mt-4 text-sm text-zinc-600">
              All stored reviews for this location already have a published
              reply.
            </p>
          )}

        {visibleReviews.length > 0 && (
          <ul className="mt-4 divide-y divide-zinc-100">
            {visibleReviews.map((review) => (
              <li key={review.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-zinc-900">
                    {review.reviewerDisplayName || "Reviewer"}
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-xs font-medium ${
                        review.replyComment
                          ? "bg-emerald-50 text-emerald-800"
                          : "bg-amber-50 text-amber-900"
                      }`}
                    >
                      {review.replyComment ? "Replied" : "Needs reply"}
                    </span>
                  </p>
                  <p className="text-sm tabular-nums text-zinc-600">
                    {review.starRating != null
                      ? `${review.starRating} / 5`
                      : "No rating"}
                    {review.createTime
                      ? ` · ${new Date(review.createTime).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>
                {review.comment ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">
                    {review.comment}
                  </p>
                ) : (
                  <p className="mt-1 text-sm italic text-zinc-500">
                    (No comment text)
                  </p>
                )}
                <ReviewDraftControls
                  reviewId={review.id}
                  starRating={review.starRating}
                  initialDraftText={review.draftText}
                  initialDraftApproved={review.draftApproved}
                  initialPublishedReply={
                    review.replyComment
                      ? {
                          comment: review.replyComment,
                          updateTime: review.replyUpdateTime,
                          state: review.replyState,
                        }
                      : null
                  }
                  onPublished={(reply) => {
                    setReviews((prev) =>
                      prev.map((item) =>
                        item.id === review.id
                          ? {
                              ...item,
                              replyComment: reply.comment,
                              replyUpdateTime: reply.updateTime,
                              replyState: reply.state,
                            }
                          : item
                      )
                    );
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
