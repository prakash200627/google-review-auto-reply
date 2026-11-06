"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { ReviewDraftControls } from "@/components/ReviewDraftControls";
import {
  SearchableSelect,
  type SearchableOption,
} from "@/components/reviews/SearchableSelect";
import {
  buildFilterChips,
  clearFilterKey,
  EMPTY_REVIEWS_FILTERS,
  hasActiveSecondaryFilters,
  SEARCH_DEBOUNCE_MS,
  type ReviewsFilterState,
} from "@/components/reviews/reviewFilters";
import {
  emptyStateDetail,
  formatReviewDate,
  parseReviewsTab,
  replyStatusLabel,
  REVIEWS_TABS,
  tabToReplyStatus,
  type ReviewsTab,
} from "@/components/reviews/reviewStatus";
import type {
  ReviewInboxItem,
  ReviewInboxMetrics,
} from "@/lib/reviews/queryInbox";

type FilterOption = { id: string; name: string; groupId?: string | null };
type LocationOption = { id: string; title: string };

type InboxResponse = {
  success?: boolean;
  reviews?: ReviewInboxItem[];
  total?: number;
  page?: number;
  pageSize?: number;
  metrics?: ReviewInboxMetrics;
  filters?: {
    groups?: FilterOption[];
    businesses?: FilterOption[];
    locations?: LocationOption[];
  };
  message?: string;
};

const PAGE_SIZE = 25;

function MetricsRow({ metrics }: { metrics: ReviewInboxMetrics }) {
  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {(
        [
          ["Total", metrics.total],
          ["Unanswered", metrics.unreplied],
          ["Drafts", metrics.draftsPending],
          ["Published", metrics.published],
        ] as const
      ).map(([label, value]) => (
        <div
          key={label}
          className="rounded-md border border-zinc-200 bg-white px-3 py-2"
        >
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            {label}
          </p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-900">
            {value}
          </p>
        </div>
      ))}
    </section>
  );
}

export function ReviewsWorkspace({
  initialBusinessId = null,
  initialGroupId = null,
  businessName = null,
  groupName = null,
  businessChoices = [],
  isSuperAdmin = false,
  activeOrgId = null,
}: {
  initialBusinessId?: string | null;
  initialGroupId?: string | null;
  businessName?: string | null;
  groupName?: string | null;
  businessChoices?: Array<{ id: string; name: string }>;
  isSuperAdmin?: boolean;
  /** Active organization id from the server; change clears stale client state. */
  activeOrgId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const tab = parseReviewsTab(searchParams.get("tab"));
  const businessId =
    searchParams.get("businessId") || initialBusinessId || "";
  const urlGroupId =
    searchParams.get("groupId") || initialGroupId || "";

  const [reviews, setReviews] = useState<ReviewInboxItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [metrics, setMetrics] = useState<ReviewInboxMetrics | null>(null);
  const [groups, setGroups] = useState<FilterOption[]>([]);
  const [businesses, setBusinesses] = useState<FilterOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [filters, setFilters] =
    useState<ReviewsFilterState>(EMPTY_REVIEWS_FILTERS);
  const [qDraft, setQDraft] = useState("");

  /** groupId is URL-owned (same pattern as businessId) so deep links stay in sync. */
  const scopedFilters = useMemo(
    () => ({ ...filters, groupId: urlGroupId }),
    [filters, urlGroupId]
  );

  const requestSeq = useRef(0);
  const lastOrgIdRef = useRef<string | null>(activeOrgId ?? null);

  // Organization switch: drop stale reviews, selection, and secondary filters.
  useEffect(() => {
    const next = activeOrgId ?? null;
    if (lastOrgIdRef.current === next) return;
    lastOrgIdRef.current = next;
    requestSeq.current += 1;
    setReviews([]);
    setTotal(0);
    setPage(1);
    setMetrics(null);
    setGroups([]);
    setBusinesses([]);
    setLocations([]);
    setSelectedId(null);
    setMobileDetail(false);
    setFilters(EMPTY_REVIEWS_FILTERS);
    setQDraft("");
    setHasLoaded(false);
    setError(null);
    setLoading(true);
  }, [activeOrgId]);

  const selected = useMemo(
    () => reviews.find((r) => r.id === selectedId) || null,
    [reviews, selectedId]
  );

  const businessOptions: SearchableOption[] = useMemo(() => {
    const source =
      businessChoices.length > 0
        ? businessChoices
        : businesses.map((b) => ({ id: b.id, name: b.name }));
    return source.map((b) => ({ id: b.id, label: b.name }));
  }, [businessChoices, businesses]);

  const locationOptions: SearchableOption[] = useMemo(
    () => locations.map((l) => ({ id: l.id, label: l.title || l.id })),
    [locations]
  );

  const selectedBusinessLabel = useMemo(() => {
    if (businessName && businessId === initialBusinessId) return businessName;
    const match = businessOptions.find((b) => b.id === businessId);
    if (match) return match.label;
    if (isSuperAdmin && !businessId && !urlGroupId) {
      return "All businesses in organization";
    }
    return null;
  }, [
    businessName,
    businessId,
    initialBusinessId,
    businessOptions,
    isSuperAdmin,
    urlGroupId,
  ]);

  const selectedGroupLabel = useMemo(() => {
    if (!urlGroupId) return null;
    if (groupName && urlGroupId === (initialGroupId || urlGroupId)) {
      return groupName;
    }
    return groups.find((g) => g.id === urlGroupId)?.name || urlGroupId;
  }, [urlGroupId, groupName, initialGroupId, groups]);

  const chips = useMemo(
    () =>
      buildFilterChips(scopedFilters, {
        locationTitle: locations.find((l) => l.id === scopedFilters.locationId)
          ?.title,
        groupName: selectedGroupLabel || undefined,
      }),
    [scopedFilters, locations, selectedGroupLabel]
  );

  const syncQuery = useCallback(
    (patch: { tab?: ReviewsTab; businessId?: string; groupId?: string }) => {
      const params = new URLSearchParams(searchParams.toString());
      const nextTab = patch.tab ?? tab;
      params.set("tab", nextTab);
      const nextBiz =
        patch.businessId !== undefined ? patch.businessId : businessId;
      if (nextBiz) params.set("businessId", nextBiz);
      else params.delete("businessId");
      const nextGroup =
        patch.groupId !== undefined ? patch.groupId : urlGroupId;
      if (nextGroup) params.set("groupId", nextGroup);
      else params.delete("groupId");
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [searchParams, tab, businessId, urlGroupId, pathname, router]
  );

  const setTab = useCallback(
    (next: ReviewsTab) => {
      syncQuery({ tab: next });
      setSelectedId(null);
      setMobileDetail(false);
      setPage(1);
    },
    [syncQuery]
  );

  const load = useCallback(
    async (opts?: { page?: number; soft?: boolean }) => {
      const nextPage = opts?.page ?? 1;
      const seq = ++requestSeq.current;
      if (opts?.soft || hasLoaded) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        params.set("replyStatus", tabToReplyStatus(tab));
        params.set("page", String(nextPage));
        params.set("pageSize", String(PAGE_SIZE));
        params.set("includeMetrics", "1");
        if (scopedFilters.groupId)
          params.set("groupId", scopedFilters.groupId);
        if (businessId) params.set("businessId", businessId);
        if (scopedFilters.locationId)
          params.set("locationId", scopedFilters.locationId);
        if (scopedFilters.starRating)
          params.set("starRating", scopedFilters.starRating);
        if (scopedFilters.flagged)
          params.set("flagged", scopedFilters.flagged);
        if (scopedFilters.q.trim()) params.set("q", scopedFilters.q.trim());
        if (scopedFilters.from) {
          params.set("from", new Date(scopedFilters.from).toISOString());
        }
        if (scopedFilters.to) {
          const end = new Date(scopedFilters.to);
          end.setHours(23, 59, 59, 999);
          params.set("to", end.toISOString());
        }

        const res = await fetch(`/api/reviews/inbox?${params.toString()}`);
        const data = (await res.json()) as InboxResponse;
        if (seq !== requestSeq.current) return;

        if (!res.ok || !data.success) {
          setError(data.message || "Could not load reviews");
          setReviews([]);
          setTotal(0);
          setMetrics(null);
          return;
        }

        const list = data.reviews || [];
        setReviews(list);
        setTotal(data.total || 0);
        setPage(data.page || nextPage);
        if (data.metrics) setMetrics(data.metrics);
        setGroups(data.filters?.groups || []);
        setBusinesses(data.filters?.businesses || []);
        setLocations(data.filters?.locations || []);
        setHasLoaded(true);

        setSelectedId((prev) => {
          if (prev && list.some((r) => r.id === prev)) return prev;
          return null;
        });
      } catch {
        if (seq !== requestSeq.current) return;
        setError("Could not load reviews");
        setReviews([]);
        setTotal(0);
        setMetrics(null);
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [tab, scopedFilters, businessId, hasLoaded]
  );

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load({ page: 1 });
    }, 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on tab/filters/business/group
  }, [tab, businessId, scopedFilters]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setFilters((prev) =>
        prev.q === qDraft ? prev : { ...prev, q: qDraft }
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [qDraft]);

  function applyBusiness(nextId: string) {
    setFilters((prev) => ({ ...prev, locationId: "" }));
    setPage(1);
    setSelectedId(null);
    setMobileDetail(false);
    syncQuery({ businessId: nextId });
  }

  function updateFilter<K extends keyof ReviewsFilterState>(
    key: K,
    value: ReviewsFilterState[K]
  ) {
    setPage(1);
    setSelectedId(null);
    setMobileDetail(false);
    if (key === "groupId") {
      syncQuery({ groupId: String(value || "") });
      return;
    }
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function clearAllFilters() {
    setFilters(EMPTY_REVIEWS_FILTERS);
    setQDraft("");
    setPage(1);
    setSelectedId(null);
    setMobileDetail(false);
    setFiltersOpen(false);
    syncQuery({ groupId: "" });
  }

  function removeChip(key: (typeof chips)[number]["key"]) {
    if (key === "groupId") {
      syncQuery({ groupId: "" });
      setPage(1);
      return;
    }
    setFilters((prev) => clearFilterKey(prev, key));
    if (key === "q") setQDraft("");
    setPage(1);
  }

  function selectReview(id: string) {
    setSelectedId(id);
    setMobileDetail(true);
  }

  function patchReview(id: string, patch: Partial<ReviewInboxItem>) {
    setReviews((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showEmpty = !loading && !error && reviews.length === 0 && hasLoaded;
  const emptyCopy = emptyStateDetail({
    tab,
    hasActiveFilters: hasActiveSecondaryFilters(scopedFilters),
    locationCount: locations.length,
    metricsTotal: metrics?.total ?? null,
  });

  const detailPanel = !selected ? (
    <p className="text-sm text-zinc-600">
      Select a review to view details and manage the reply draft.
    </p>
  ) : (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-900">
          {selected.reviewerDisplayName || "Anonymous"}
          {selected.starRating != null ? ` · ${selected.starRating}★` : ""}
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          {formatReviewDate(selected.createTime)}
          {selected.locationTitle ? ` · ${selected.locationTitle}` : ""}
          {` · ${replyStatusLabel(selected)}`}
        </p>
        <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-800">
          {selected.comment || "(no comment)"}
        </p>
      </div>

      {tab === "published" && selected.replyComment ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50/80 px-3 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-800">
            Published reply
            {selected.replySource ? ` · ${selected.replySource}` : ""}
            {selected.replyUpdateTime
              ? ` · ${formatReviewDate(selected.replyUpdateTime)}`
              : ""}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-emerald-950">
            {selected.replyComment}
          </p>
        </div>
      ) : null}

      {tab === "drafts" && (
        <p className="text-xs text-zinc-600">
          Draft status:{" "}
          <span className="font-medium text-zinc-800">
            {selected.draftStatus || "none"}
            {selected.draftApproved ? " (approved)" : ""}
          </span>
          {selected.draftUpdatedAt
            ? ` · updated ${formatReviewDate(selected.draftUpdatedAt)}`
            : ""}
          . Publishing still requires explicit confirmation.
        </p>
      )}

      <ReviewDraftControls
        key={selected.id}
        reviewId={selected.id}
        starRating={selected.starRating}
        initialDraftText={selected.draftText}
        initialDraftApproved={selected.draftApproved}
        initialPublishedReply={
          selected.replyComment?.trim()
            ? {
                comment: selected.replyComment,
                updateTime: selected.replyUpdateTime,
                state: "",
              }
            : null
        }
        onDraftSaved={(info) => {
          patchReview(selected.id, {
            draftText: info.draftText,
            draftApproved: info.draftApproved,
            draftStatus: info.draftStatus,
            draftUpdatedAt: new Date().toISOString(),
          });
          void load({ soft: true, page });
        }}
        onPublished={(reply) => {
          patchReview(selected.id, {
            replyComment: reply.comment,
            replyUpdateTime: reply.updateTime,
          });
          void load({ soft: true, page });
        }}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-zinc-600">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link href="/orm" className="underline hover:text-zinc-900">
              ORM
            </Link>
          </li>
          <li className="text-zinc-400" aria-hidden>
            /
          </li>
          {businessId ? (
            <>
              <li>
                <Link
                  href={`/orm/business/${encodeURIComponent(businessId)}`}
                  className="underline hover:text-zinc-900"
                >
                  {selectedBusinessLabel || "Business"}
                </Link>
              </li>
              <li className="text-zinc-400" aria-hidden>
                /
              </li>
            </>
          ) : urlGroupId ? (
            <>
              <li>
                <Link
                  href={`/orm/group/${encodeURIComponent(urlGroupId)}`}
                  className="underline hover:text-zinc-900"
                >
                  {selectedGroupLabel || "Group"}
                </Link>
              </li>
              <li className="text-zinc-400" aria-hidden>
                /
              </li>
            </>
          ) : null}
          <li className="font-medium text-zinc-800" aria-current="page">
            Reviews
          </li>
        </ol>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
            Reviews
          </h2>
          <p className="mt-1 max-w-xl text-sm text-zinc-600">
            Inbox for stored Google reviews. Generate, edit, and approve drafts
            here — publish only after you confirm.
          </p>
          {selectedBusinessLabel && (
            <p className="mt-1 text-sm text-zinc-800">
              <span className="text-zinc-500">Business:</span>{" "}
              {selectedBusinessLabel}
            </p>
          )}
          {selectedGroupLabel && !businessId && (
            <p className="mt-1 text-sm text-zinc-800">
              <span className="text-zinc-500">Group:</span> {selectedGroupLabel}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load({ soft: true, page })}
          disabled={loading || refreshing}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {(isSuperAdmin || businessOptions.length > 1) && (
        <div className="max-w-sm">
          <SearchableSelect
            label="Business"
            value={businessId}
            options={businessOptions}
            onChange={applyBusiness}
            emptyLabel={
              isSuperAdmin
                ? "All businesses in organization"
                : "Select business"
            }
            placeholder="Search businesses…"
            selectedLabelFallback={selectedBusinessLabel}
          />
        </div>
      )}

      {loading && !metrics ? (
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          aria-hidden
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-md border border-zinc-200 bg-zinc-100"
            />
          ))}
        </div>
      ) : metrics ? (
        <MetricsRow metrics={metrics} />
      ) : null}

      <nav
        className="flex gap-1 border-b border-zinc-200"
        aria-label="Reviews sections"
      >
        {REVIEWS_TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={active ? "page" : undefined}
              className={`px-3 py-2 text-sm font-medium ${
                active
                  ? "border-b-2 border-zinc-900 text-zinc-900"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Search reviewer or text"
            className="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
            aria-label="Search reviews"
          />
          <div className="w-full sm:w-56">
            <SearchableSelect
              label="Location"
              value={scopedFilters.locationId}
              options={locationOptions}
              onChange={(id) => updateFilter("locationId", id)}
              emptyLabel={
                locationOptions.length === 0
                  ? "No locations available"
                  : "All locations"
              }
              placeholder="Search locations…"
              disabled={locationOptions.length === 0}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersOpen}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Filters{chips.length > 0 ? ` (${chips.length})` : ""}
            </button>
            {hasActiveSecondaryFilters(scopedFilters) && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="rounded-md px-2 py-1.5 text-sm text-zinc-600 underline hover:text-zinc-900"
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {filtersOpen && (
          <div className="grid gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-xs text-zinc-600">
              Rating
              <select
                value={scopedFilters.starRating}
                onChange={(e) => updateFilter("starRating", e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="">Any</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}★
                  </option>
                ))}
              </select>
            </label>
            {(isSuperAdmin || groups.length > 0) && (
              <label className="block text-xs text-zinc-600">
                Group
                <select
                  value={urlGroupId}
                  onChange={(e) => updateFilter("groupId", e.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                >
                  <option value="">All groups</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-xs text-zinc-600">
              Flagged
              <select
                value={scopedFilters.flagged}
                onChange={(e) => updateFilter("flagged", e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="">Any</option>
                <option value="true">Flagged only</option>
                <option value="false">Not flagged</option>
              </select>
            </label>
            <label className="block text-xs text-zinc-600">
              From
              <input
                type="date"
                value={scopedFilters.from}
                onChange={(e) => updateFilter("from", e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block text-xs text-zinc-600">
              To
              <input
                type="date"
                value={scopedFilters.to}
                onChange={(e) => updateFilter("to", e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              />
            </label>
          </div>
        )}

        {chips.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Active filters">
            {chips.map((chip) => (
              <li key={chip.key + chip.label}>
                <button
                  type="button"
                  onClick={() => removeChip(chip.key)}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                >
                  {chip.label}
                  <span aria-hidden>×</span>
                  <span className="sr-only">Remove {chip.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-zinc-500">
        Stored data only.{" "}
        <Link href="/gmb/locations" className="underline">
          Discover / fetch from Google
        </Link>{" "}
        under GMB (never automatic).
      </p>

      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void load({ soft: true, page })}
            className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section
          className={`min-w-0 space-y-3 ${
            mobileDetail ? "hidden lg:block" : "block"
          }`}
        >
          <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
            <span>
              {loading && !hasLoaded
                ? "Loading…"
                : `Showing ${reviews.length} of ${total}`}
            </span>
            {refreshing && <span role="status">Updating…</span>}
          </div>

          {loading && !hasLoaded ? (
            <ul className="space-y-2" aria-hidden>
              {Array.from({ length: 5 }).map((_, i) => (
                <li
                  key={i}
                  className="h-14 animate-pulse rounded-md border border-zinc-200 bg-zinc-100"
                />
              ))}
            </ul>
          ) : showEmpty ? (
            <div className="rounded-md border border-dashed border-zinc-300 bg-white px-4 py-8 text-center">
              <p className="text-sm font-medium text-zinc-800">
                {emptyCopy.title}
              </p>
              <p className="mt-2 text-sm text-zinc-600">{emptyCopy.detail}</p>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white">
              {reviews.map((review) => {
                const active = review.id === selectedId;
                return (
                  <li key={review.id}>
                    <button
                      type="button"
                      onClick={() => selectReview(review.id)}
                      className={`w-full px-3 py-2.5 text-left transition hover:bg-zinc-50 ${
                        active ? "bg-zinc-50" : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-sm font-medium text-zinc-900">
                          {review.reviewerDisplayName || "Anonymous"}
                          {review.starRating != null
                            ? ` · ${review.starRating}★`
                            : ""}
                        </p>
                        <span className="text-xs text-zinc-500">
                          {replyStatusLabel(review)}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-sm text-zinc-700">
                        {review.comment || "(no comment)"}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {formatReviewDate(review.createTime)}
                        {review.locationTitle
                          ? ` · ${review.locationTitle}`
                          : ""}
                        {review.flagged ? " · flagged" : ""}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {totalPages > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => void load({ page: page - 1, soft: true })}
                className="rounded-md border border-zinc-300 px-2 py-1 disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-zinc-600">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => void load({ page: page + 1, soft: true })}
                className="rounded-md border border-zinc-300 px-2 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </section>

        <section
          className={`min-w-0 rounded-md border border-zinc-200 bg-white p-4 ${
            mobileDetail ? "block" : "hidden lg:block"
          }`}
        >
          {mobileDetail && (
            <button
              type="button"
              className="mb-3 text-sm text-zinc-600 underline lg:hidden"
              onClick={() => {
                setMobileDetail(false);
              }}
            >
              ← Back to list
            </button>
          )}
          {detailPanel}
        </section>
      </div>
    </div>
  );
}
