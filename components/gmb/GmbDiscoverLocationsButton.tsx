"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Super Admin only — discover/upsert GBP locations for the connected org.
 * Kept on GMB Locations so ORM Reviews stays inbox-focused.
 */
export function GmbDiscoverLocationsButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string | null>(null);

  async function discover() {
    if (state === "loading") return;
    setState("loading");
    setMessage(null);
    try {
      const res = await fetch("/api/google/locations", { method: "POST" });
      const data = (await res.json()) as {
        success?: boolean;
        discovered?: number;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setState("error");
        setMessage(data.message || "Location discovery failed");
        return;
      }
      setState("done");
      setMessage(
        `Discovered ${data.discovered ?? 0} location(s) from Google. No reviews were fetched and nothing was published.`
      );
      router.refresh();
    } catch {
      setState("error");
      setMessage("Location discovery failed");
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void discover()}
        disabled={state === "loading"}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === "loading" ? "Discovering…" : "Discover locations from Google"}
      </button>
      <p className="text-xs text-zinc-600">
        Reads Business Profile locations for the connected Google account and
        stores them in TRONX. Does not assign businesses, sync reviews, or
        publish replies. Not run automatically.
      </p>
      {message && (
        <p
          className={`rounded-md px-3 py-2 text-sm ${
            state === "error"
              ? "bg-red-50 text-red-800"
              : "bg-emerald-50 text-emerald-800"
          }`}
          role="status"
        >
          {message}
        </p>
      )}
    </div>
  );
}
