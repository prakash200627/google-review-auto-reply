"use client";

import { useEffect, useState } from "react";

type Keyword = {
  id: string;
  keyword: string;
  targetLocation: string;
};
type Ranking = {
  id: string;
  keywordId: string;
  position: number;
  observedAt: string | null;
};
type Job = {
  id: string;
  title: string;
  type: string;
  status: string;
  ownerSummary: string;
  staffNotes?: string;
};
type Flag = {
  id: string;
  reason: string;
  status: string;
  reviewId?: string;
  staffNotes?: string;
};

async function fetchStaffOps(businessId: string): Promise<{
  keywords: Keyword[];
  rankings: Ranking[];
  jobs: Job[];
  flags: Flag[];
  error: string | null;
}> {
  try {
    const [seoRes, svcRes, flagRes] = await Promise.all([
      fetch(`/api/business/${encodeURIComponent(businessId)}/seo`),
      fetch(`/api/business/${encodeURIComponent(businessId)}/services`),
      fetch(`/api/business/${encodeURIComponent(businessId)}/flags`),
    ]);
    const seo = (await seoRes.json()) as {
      success?: boolean;
      keywords?: Keyword[];
      rankings?: Ranking[];
    };
    const svc = (await svcRes.json()) as {
      success?: boolean;
      jobs?: Job[];
    };
    const flagsJson = (await flagRes.json()) as {
      success?: boolean;
      flags?: Flag[];
    };
    return {
      keywords: seoRes.ok && seo.success ? seo.keywords || [] : [],
      rankings: seoRes.ok && seo.success ? seo.rankings || [] : [],
      jobs: svcRes.ok && svc.success ? svc.jobs || [] : [],
      flags: flagRes.ok && flagsJson.success ? flagsJson.flags || [] : [],
      error: null,
    };
  } catch {
    return {
      keywords: [],
      rankings: [],
      jobs: [],
      flags: [],
      error: "Could not load staff ops data.",
    };
  }
}

/**
 * Super Admin staff tools for a single business: SEO, GMB jobs, fake-review flags.
 * Owners never see this panel; staff notes stay on SA responses only.
 */
export function AdminBusinessOpsPanel({ businessId }: { businessId: string }) {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [rankings, setRankings] = useState<Ranking[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [keyword, setKeyword] = useState("");
  const [targetLocation, setTargetLocation] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobType, setJobType] = useState("setup");
  const [rankPosition, setRankPosition] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await fetchStaffOps(businessId);
      if (cancelled) return;
      setKeywords(data.keywords);
      setRankings(data.rankings);
      setJobs(data.jobs);
      setFlags(data.flags);
      if (data.error) setError(data.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  async function reload() {
    setError(null);
    const data = await fetchStaffOps(businessId);
    setKeywords(data.keywords);
    setRankings(data.rankings);
    setJobs(data.jobs);
    setFlags(data.flags);
    if (data.error) setError(data.error);
  }

  async function createKeyword() {
    if (!keyword.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/seo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create_keyword",
            keyword,
            targetLocation,
          }),
        }
      );
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not create keyword");
        return;
      }
      setKeyword("");
      setMessage("Keyword created");
      await reload();
    } catch {
      setError("Could not create keyword");
    } finally {
      setBusy(false);
    }
  }

  async function recordRanking(keywordId: string, position: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/seo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record_ranking",
            keywordId,
            position,
          }),
        }
      );
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not record ranking");
        return;
      }
      setMessage(`Ranking recorded at #${position}`);
      await reload();
    } catch {
      setError("Could not record ranking");
    } finally {
      setBusy(false);
    }
  }

  async function deactivateKeyword(keywordId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/seo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "deactivate_keyword",
            keywordId,
          }),
        }
      );
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not deactivate keyword");
        return;
      }
      setMessage("Keyword deactivated");
      await reload();
    } catch {
      setError("Could not deactivate keyword");
    } finally {
      setBusy(false);
    }
  }

  async function createJob() {
    if (!jobTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/services`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: jobTitle,
            type: jobType,
            ownerSummary:
              "TRONX is working on your Google Business Profile request.",
          }),
        }
      );
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not create job");
        return;
      }
      setJobTitle("");
      setMessage("Service job created");
      await reload();
    } catch {
      setError("Could not create job");
    } finally {
      setBusy(false);
    }
  }

  async function updateJobStatus(jobId: string, status: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/services`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, status }),
        }
      );
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not update job");
        return;
      }
      setMessage("Job status updated");
      await reload();
    } catch {
      setError("Could not update job");
    } finally {
      setBusy(false);
    }
  }

  async function updateFlagStatus(flagId: string, reviewId: string, status: string) {
    if (!reviewId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/reviews/${encodeURIComponent(reviewId)}/flag`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flagId, status }),
        }
      );
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not update flag");
        return;
      }
      setMessage("Flag updated");
      await reload();
    } catch {
      setError("Could not update flag");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-4 rounded-md border border-zinc-200 bg-zinc-50 p-4">
      <h3 className="text-sm font-semibold text-zinc-900">
        Staff ops (SEO · GMB · flags)
      </h3>
      <p className="text-xs text-zinc-600">
        Internal TRONX tools. Owners see read-only SEO/services without staff
        notes.
      </p>
      {error && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-800">{error}</p>
      )}
      {message && (
        <p className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
          {message}
        </p>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Local SEO keywords
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
            placeholder="Keyword"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <input
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
            placeholder="Target location"
            value={targetLocation}
            onChange={(e) => setTargetLocation(e.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void createKeyword()}
            className="rounded bg-zinc-900 px-2 py-1 text-xs text-white disabled:opacity-50"
          >
            Add keyword
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-600">
          Ranking position
          <input
            type="number"
            min={1}
            max={100}
            className="w-16 rounded border border-zinc-300 px-1 py-0.5"
            value={rankPosition}
            onChange={(e) => setRankPosition(Number(e.target.value) || 1)}
          />
        </label>
        <ul className="space-y-1 text-sm">
          {keywords.map((k) => {
            const latest = rankings.find((r) => r.keywordId === k.id);
            return (
              <li key={k.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {k.keyword}
                  {k.targetLocation ? ` · ${k.targetLocation}` : ""}
                  {latest ? ` · #${latest.position}` : " · no ranking"}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded border border-zinc-300 px-2 py-0.5 text-xs"
                  onClick={() => void recordRanking(k.id, rankPosition)}
                >
                  Record #{rankPosition}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-800"
                  onClick={() => void deactivateKeyword(k.id)}
                >
                  Deactivate
                </button>
              </li>
            );
          })}
          {keywords.length === 0 && (
            <li className="text-zinc-500">No keywords yet.</li>
          )}
        </ul>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          GMB service jobs
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
            placeholder="Job title"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          />
          <select
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
            value={jobType}
            onChange={(e) => setJobType(e.target.value)}
          >
            <option value="setup">Setup</option>
            <option value="suspension_assistance">Suspension assistance</option>
            <option value="recovery_assistance">Recovery assistance</option>
            <option value="other">Other</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => void createJob()}
            className="rounded bg-zinc-900 px-2 py-1 text-xs text-white disabled:opacity-50"
          >
            Create job
          </button>
        </div>
        <ul className="space-y-1 text-sm">
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-2">
              <span>
                {j.title} · {j.type} · {j.status}
                {j.staffNotes ? (
                  <span className="text-zinc-500"> · staff: {j.staffNotes}</span>
                ) : null}
              </span>
              <select
                className="rounded border border-zinc-300 px-1 py-0.5 text-xs"
                value={j.status}
                disabled={busy}
                onChange={(e) => void updateJobStatus(j.id, e.target.value)}
              >
                <option value="open">open</option>
                <option value="in_progress">in_progress</option>
                <option value="waiting_on_customer">waiting_on_customer</option>
                <option value="waiting_on_google">waiting_on_google</option>
                <option value="completed">completed</option>
                <option value="cancelled">cancelled</option>
              </select>
            </li>
          ))}
          {jobs.length === 0 && (
            <li className="text-zinc-500">No service jobs yet.</li>
          )}
        </ul>
      </div>

      <div className="space-y-1 text-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Fake-review flags
        </p>
        {flags.length === 0 && (
          <p className="text-zinc-500">No flags for this business.</p>
        )}
        {flags.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center gap-2">
            <span>
              {f.status}: {f.reason}
              {f.staffNotes ? ` · ${f.staffNotes}` : ""}
            </span>
            {f.reviewId && (
              <select
                className="rounded border border-zinc-300 px-1 py-0.5 text-xs"
                value={f.status}
                disabled={busy}
                onChange={(e) =>
                  void updateFlagStatus(f.id, f.reviewId!, e.target.value)
                }
              >
                <option value="open">open</option>
                <option value="investigating">investigating</option>
                <option value="dismissed">dismissed</option>
                <option value="confirmed_suspicious">
                  confirmed_suspicious
                </option>
              </select>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
