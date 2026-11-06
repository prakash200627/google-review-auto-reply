"use client";

import { useEffect, useState } from "react";

type AutoPublishConfig = {
  enabled: boolean;
  syncIntervalMinutes: number;
  publishDelayMinutes: number;
  maxAutoStarRatingExclusive: number;
  disabledByAdmin: boolean;
};

/**
 * Super Admin controls for business auto-publish config.
 * Does not enable the global kill switch or run the processor.
 */
export function AdminAutoPublishPanel({ businessId }: { businessId: string }) {
  const [config, setConfig] = useState<AutoPublishConfig | null>(null);
  const [globallyEnabled, setGloballyEnabled] = useState(false);
  const [automationEntitled, setAutomationEntitled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/businesses/${encodeURIComponent(businessId)}/auto-publish`
        );
        const data = (await res.json()) as {
          success?: boolean;
          autoPublish?: AutoPublishConfig;
          globallyEnabled?: boolean;
          plan?: { automationEntitled?: boolean };
          message?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.success || !data.autoPublish) {
          setError(data.message || "Could not load auto-publish config");
          return;
        }
        setConfig(data.autoPublish);
        setGloballyEnabled(Boolean(data.globallyEnabled));
        setAutomationEntitled(Boolean(data.plan?.automationEntitled));
        setLoadedFor(businessId);
      } catch {
        if (!cancelled) setError("Could not load auto-publish config");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  async function save(patch: Partial<AutoPublishConfig>) {
    if (!config) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = { ...config, ...patch };
      const res = await fetch(
        `/api/admin/businesses/${encodeURIComponent(businessId)}/auto-publish`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        autoPublish?: AutoPublishConfig;
        message?: string;
      };
      if (!res.ok || !data.success || !data.autoPublish) {
        setError(data.message || "Could not save auto-publish config");
        return;
      }
      setConfig(data.autoPublish);
      setMessage(data.message || "Auto-publish settings saved");
    } catch {
      setError("Could not save auto-publish config");
    } finally {
      setBusy(false);
    }
  }

  if (loadedFor !== businessId && !config && !error) {
    return (
      <p className="text-xs text-zinc-500">Loading auto-publish settings…</p>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-3">
      <h3 className="text-sm font-semibold text-zinc-900">
        Auto-publish safety controls
      </h3>
      <p className="text-xs text-zinc-700">
        Global kill switch:{" "}
        <span className="font-medium">
          {globallyEnabled ? "ON (env)" : "OFF (default)"}
        </span>
        . Plan automation entitlement:{" "}
        <span className="font-medium">
          {automationEntitled ? "yes" : "no"}
        </span>
        . Enabling here does not publish until the global env flag and
        scheduler secret are set. Queue enqueue remains gated.
      </p>
      {error && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-800">{error}</p>
      )}
      {message && (
        <p className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
          {message}
        </p>
      )}
      {config && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={busy || !automationEntitled}
              onChange={(e) =>
                void save({
                  enabled: e.target.checked,
                  disabledByAdmin: !e.target.checked,
                })
              }
            />
            Enabled for this business
          </label>
          <label className="text-xs">
            Min stars exclusive (publish below this only)
            <input
              type="number"
              min={3}
              max={6}
              className="ml-1 w-16 rounded border border-zinc-300 px-1 py-0.5"
              value={config.maxAutoStarRatingExclusive}
              disabled={busy}
              onChange={(e) =>
                setConfig({
                  ...config,
                  maxAutoStarRatingExclusive: Number(e.target.value) || 4,
                })
              }
              onBlur={() =>
                void save({
                  maxAutoStarRatingExclusive: config.maxAutoStarRatingExclusive,
                })
              }
            />
          </label>
          <label className="text-xs">
            Delay (min)
            <input
              type="number"
              min={0}
              className="ml-1 w-16 rounded border border-zinc-300 px-1 py-0.5"
              value={config.publishDelayMinutes}
              disabled={busy}
              onChange={(e) =>
                setConfig({
                  ...config,
                  publishDelayMinutes: Number(e.target.value) || 0,
                })
              }
              onBlur={() =>
                void save({ publishDelayMinutes: config.publishDelayMinutes })
              }
            />
          </label>
          <button
            type="button"
            disabled={busy || config.enabled === false}
            className="rounded border border-zinc-400 px-2 py-1 text-xs"
            onClick={() =>
              void save({ enabled: false, disabledByAdmin: true })
            }
          >
            Disable (admin)
          </button>
        </div>
      )}
    </div>
  );
}
