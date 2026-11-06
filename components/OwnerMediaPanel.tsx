"use client";

import { useState } from "react";

type MediaRow = {
  id: string;
  purpose: string;
  secureUrl: string;
  originalFilename?: string;
  createdAt?: string | null;
};

export function OwnerMediaPanel({ businessId }: { businessId: string }) {
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [missing, setMissing] = useState<string[]>([]);
  const [purpose, setPurpose] = useState<"internal" | "gbp_candidate">(
    "internal"
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function reload() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/media`
      );
      const data = (await res.json()) as {
        success?: boolean;
        media?: MediaRow[];
        cloudinary?: { configured?: boolean; missing?: string[] };
        message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not load media");
        return;
      }
      setMedia(data.media || []);
      setConfigured(Boolean(data.cloudinary?.configured));
      setMissing(data.cloudinary?.missing || []);
      setLoaded(true);
    } catch {
      setError("Could not load media");
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("purpose", purpose);
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/media`,
        { method: "POST", body: form }
      );
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        note?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Upload failed");
        return;
      }
      setMessage(data.note || "Uploaded");
      await reload();
    } catch {
      setError("Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(mediaId: string) {
    if (!window.confirm("Remove this TRONX media asset?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/media`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaId }),
        }
      );
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Delete failed");
        return;
      }
      setMessage(data.message || "Removed");
      await reload();
    } catch {
      setError("Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold tracking-tight">Outlet photos</h2>
      <p className="mt-1 text-sm text-zinc-600">
        TRONX media library (Cloudinary). Uploading here does{" "}
        <strong>not</strong> change Google Business Profile photos. Mark as
        &quot;GBP candidate&quot; only to track assets intended for later Google
        use.
      </p>
      {!configured && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Cloudinary is not configured
          {missing.length ? ` (missing ${missing.join(", ")})` : ""}. Uploads
          are disabled until server env is set.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void reload()}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50"
        >
          {loaded ? "Refresh photos" : "Load photos"}
        </button>
        <label className="text-sm">
          Purpose{" "}
          <select
            className="ml-1 rounded-md border border-zinc-300 px-2 py-1"
            value={purpose}
            onChange={(e) =>
              setPurpose(
                e.target.value === "gbp_candidate"
                  ? "gbp_candidate"
                  : "internal"
              )
            }
          >
            <option value="internal">Internal TRONX asset</option>
            <option value="gbp_candidate">GBP candidate (not pushed)</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="sr-only">Upload photo</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy || !configured}
            onChange={(e) => void onUpload(e)}
          />
        </label>
      </div>
      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {message && (
        <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </p>
      )}
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {media.map((m) => (
          <li
            key={m.id}
            className="rounded-md border border-zinc-200 p-2 text-sm"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={m.secureUrl}
              alt={m.originalFilename || "Outlet photo"}
              className="h-32 w-full rounded object-cover"
            />
            <p className="mt-1 text-xs text-zinc-600">
              {m.purpose === "gbp_candidate"
                ? "GBP candidate (TRONX only)"
                : "Internal TRONX asset"}
            </p>
            <button
              type="button"
              disabled={busy}
              className="mt-1 text-xs text-red-700 underline disabled:opacity-50"
              onClick={() => void remove(m.id)}
            >
              Remove
            </button>
          </li>
        ))}
        {media.length === 0 && (
          <li className="text-sm text-zinc-500">No photos uploaded yet.</li>
        )}
      </ul>
    </section>
  );
}
