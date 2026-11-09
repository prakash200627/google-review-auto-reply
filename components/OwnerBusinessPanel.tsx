"use client";

import { useState } from "react";
import { OwnerMediaPanel } from "@/components/OwnerMediaPanel";

const BRAND_OPTIONS = [
  "friendly",
  "professional",
  "casual",
  "premium",
  "empathetic",
  "concise",
] as const;

export function OwnerBusinessPanel({
  businessId,
  initialName,
  initialBrandVoice,
  initialLanguage,
  initialToneNotes = "",
  initialPhone = "",
  replyMode: initialReplyMode,
}: {
  businessId: string;
  initialName: string;
  initialBrandVoice: string;
  initialLanguage: string;
  initialToneNotes?: string;
  initialPhone?: string;
  replyMode: string;
}) {
  const [name, setName] = useState(initialName);
  const [brandVoice, setBrandVoice] = useState(initialBrandVoice);
  const [language, setLanguage] = useState(initialLanguage);
  const [toneNotes, setToneNotes] = useState(initialToneNotes);
  const [phone, setPhone] = useState(initialPhone);
  const [replyMode, setReplyMode] = useState(initialReplyMode);
  const [canEditReplyMode, setCanEditReplyMode] = useState(false);
  const [autoDraftOnSync, setAutoDraftOnSync] = useState(false);
  const [autoPublishEnabled, setAutoPublishEnabled] = useState(false);
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"success" | "warning" | "info">("success");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadSettingsPermissions() {
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/settings`
      );
      const data = (await res.json()) as {
        success?: boolean;
        business?: {
          replyMode?: string;
          canEditReplyMode?: boolean;
          autoDraftOnSync?: boolean;
          autoPublishEnabled?: boolean;
        };
      };
      if (res.ok && data.success && data.business) {
        if (data.business.replyMode) setReplyMode(data.business.replyMode);
        setCanEditReplyMode(Boolean(data.business.canEditReplyMode));
        setAutoDraftOnSync(Boolean(data.business.autoDraftOnSync));
        setAutoPublishEnabled(Boolean(data.business.autoPublishEnabled));
      }
    } catch {
      /* optional */
    }
  }

  async function loadProfile() {
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/profile`
      );
      const data = (await res.json()) as {
        success?: boolean;
        tronx?: {
          phone?: string;
          address?: string;
          latitude?: number | null;
          longitude?: number | null;
        };
      };
      if (res.ok && data.success) {
        if (data.tronx?.phone) setPhone(data.tronx.phone);
        if (typeof data.tronx?.address === "string") {
          setAddress(data.tronx.address);
        }
        if (typeof data.tronx?.latitude === "number") {
          setLatitude(String(data.tronx.latitude));
        }
        if (typeof data.tronx?.longitude === "number") {
          setLongitude(String(data.tronx.longitude));
        }
      }
    } catch {
      /* optional */
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    setMessageTone("success");
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/settings`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            brandVoice,
            preferredLanguage: language,
            replyToneNotes: toneNotes,
            phone,
            ...(canEditReplyMode ? { replyMode } : {}),
          }),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not save settings");
        return;
      }
      setMessage(data.message || "Settings saved");
      setMessageTone("success");
    } catch {
      setError("Could not save settings");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile() {
    setBusy(true);
    setError(null);
    setMessage(null);
    setMessageTone("success");
    try {
      const res = await fetch(
        `/api/business/${encodeURIComponent(businessId)}/profile`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone,
            address,
            latitude: latitude === "" ? undefined : Number(latitude),
            longitude: longitude === "" ? undefined : Number(longitude),
            pushGeoToGoogle: false,
          }),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        local?: { applied?: boolean; status?: string };
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not save profile");
        return;
      }
      setMessage(data.message || "TRONX profile saved.");
      setMessageTone(data.local?.applied ? "success" : "info");
    } catch {
      setError("Could not save profile");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight">
          Business settings
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Outlet display name, AI reply tone, and TRONX contact phone. Reply mode{" "}
          {canEditReplyMode
            ? "can be changed for this business (Super Admin granted permission)."
            : "is Super Admin controlled."}{" "}
          Mode never publishes by itself
          {autoPublishEnabled
            ? "; auto-publish is separately enabled."
            : "; automatic publishing is OFF."}
          {autoDraftOnSync
            ? " Auto-draft on sync is enabled for unreplied reviews."
            : ""}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void loadSettingsPermissions()}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
          >
            Refresh reply-mode permissions
          </button>
        </div>
        <form onSubmit={(e) => void save(e)} className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="font-medium">Display name</span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Reply mode</span>
            <select
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 disabled:bg-zinc-100"
              value={replyMode}
              disabled={!canEditReplyMode}
              onChange={(e) => setReplyMode(e.target.value)}
            >
              <option value="manual">Manual — draft, approve, publish explicitly</option>
              <option value="auto">
                Automated — AI drafts may generate; publishing stays separate
              </option>
            </select>
            <span className="mt-1 block text-xs text-zinc-500">
              Automated mode does not publish replies. Auto-publish requires a
              separate Super Admin enablement and remains OFF by default.
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium">AI reply tone</span>
              <select
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={brandVoice}
                onChange={(e) => setBrandVoice(e.target.value)}
              >
                {BRAND_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium">Preferred language</span>
              <input
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="font-medium">Tone notes (optional)</span>
            <textarea
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              rows={2}
              maxLength={500}
              value={toneNotes}
              onChange={(e) => setToneNotes(e.target.value)}
              placeholder="Style guidance only — cannot bypass safety or publishing rules"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">TRONX contact phone</span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+9198…"
            />
            <span className="mt-1 block text-xs text-zinc-500">
              Stored in TRONX and separate from Google Business Profile.
            </span>
          </label>
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          )}
          {message && (
            <p className={`rounded-md px-3 py-2 text-sm ${
              messageTone === "warning"
                ? "border border-amber-300 bg-amber-50 text-amber-950"
                : messageTone === "info"
                  ? "border border-zinc-300 bg-zinc-50 text-zinc-800"
                  : "bg-emerald-50 text-emerald-800"
            }`}>
              {message}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save settings"}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight">
          TRONX location data
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Edit the internal TRONX address and coordinates for this outlet. These
          values are separate from the Google Business Profile.
        </p>
        <div className="mt-3 space-y-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void loadProfile()}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50"
          >
            Load saved location fields
          </button>
          <label className="block text-sm">
            <span className="font-medium">Address (TRONX)</span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium">Latitude</span>
              <input
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium">Longitude</span>
              <input
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveProfile()}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
            >
              Save TRONX location data
            </button>
          </div>
        </div>
      </section>

      <OwnerMediaPanel businessId={businessId} />
    </div>
  );
}
