"use client";

import { useState } from "react";
import { normalizeBusinessPhone } from "@/lib/business/phone";

type Profile = {
  title: string;
  phoneNumbers: { primaryPhone: string; additionalPhones: string[] };
  websiteUri: string;
  categories: { primaryCategory: { name: string }; additionalCategories: { name: string }[] };
  storefrontAddress: { revision: number; languageCode?: string; sublocality?: string; sortingCode?: string; recipients?: string[]; organization?: string; addressLines: string[]; locality: string; administrativeArea: string; postalCode: string; regionCode: string };
  regularHours: { periods: Array<Record<string, unknown>> };
  specialHours: { specialHourPeriods: Array<Record<string, unknown>> };
};
const empty: Profile = {
  title: "", phoneNumbers: { primaryPhone: "", additionalPhones: [] }, websiteUri: "",
  categories: { primaryCategory: { name: "" }, additionalCategories: [] },
  storefrontAddress: { revision: 0, addressLines: [""], locality: "", administrativeArea: "", postalCode: "", regionCode: "" },
  regularHours: { periods: [] }, specialHours: { specialHourPeriods: [] },
};
const inputClass = "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm";

export function SuperAdminGoogleProfileEditor({ businessId }: { businessId: string }) {
  const [profile, setProfile] = useState<Profile>(empty);
  const [before, setBefore] = useState<Profile | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "success" | "warning">("info");
  const [error, setError] = useState("");
  const [validationIssues, setValidationIssues] = useState<Array<{ field: string; message: string }>>([]);
  const [requiresReload, setRequiresReload] = useState(false);
  const [writesEnabled, setWritesEnabled] = useState(false);
  const [regularText, setRegularText] = useState("[]");
  const [specialText, setSpecialText] = useState("[]");
  const [regularJsonError, setRegularJsonError] = useState("");
  const [specialJsonError, setSpecialJsonError] = useState("");

  async function load() {
    setBusy(true); setError(""); setValidationIssues([]); setMessage("");
    try {
      const response = await fetch(`/api/business/${encodeURIComponent(businessId)}/google-profile`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not load Google profile.");
      setProfile(data.profile); setBefore(data.profile); setFingerprint(data.fingerprint); setWritesEnabled(Boolean(data.liveGoogleWritesAllowed)); setLoaded(true); setConfirmed(false); setRequiresReload(false); setMessageTone("info");
      setRegularText(JSON.stringify(data.profile.regularHours.periods, null, 2)); setSpecialText(JSON.stringify(data.profile.specialHours.specialHourPeriods, null, 2)); setRegularJsonError(""); setSpecialJsonError("");
      setMessage("Current Google profile loaded. Changes remain a draft until you review and confirm publication.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load Google profile."); }
    finally { setBusy(false); }
  }

  async function publish() {
    if (!loaded || !before || requiresReload || regularJsonError || specialJsonError) return;
    const phones = [profile.phoneNumbers.primaryPhone, ...profile.phoneNumbers.additionalPhones].filter(Boolean);
    let phoneInvalid = false;
    try { const normalized = phones.map((phone) => normalizeBusinessPhone(phone)); phoneInvalid = new Set(normalized).size !== normalized.length; }
    catch { phoneInvalid = true; }
    const addressHasData = profile.storefrontAddress.addressLines.some((line) => line.trim()) || profile.storefrontAddress.locality || profile.storefrontAddress.administrativeArea || profile.storefrontAddress.postalCode || profile.storefrontAddress.regionCode;
    const phoneChanged = JSON.stringify(profile.phoneNumbers) !== JSON.stringify(before.phoneNumbers);
    const websiteChanged = profile.websiteUri !== before.websiteUri;
    const categoriesChanged = JSON.stringify(profile.categories) !== JSON.stringify(before.categories);
    const addressChanged = JSON.stringify(profile.storefrontAddress) !== JSON.stringify(before.storefrontAddress);
    const invalid = (profile.title !== before.title && !profile.title.trim()) ||
      Boolean(phoneChanged && (phoneInvalid || profile.phoneNumbers.additionalPhones.length > 2)) ||
      Boolean(websiteChanged && profile.websiteUri && !/^https?:\/\/.+\..+/.test(profile.websiteUri)) ||
      Boolean(categoriesChanged && (!/^gcid:[a-z0-9_]+$/i.test(profile.categories.primaryCategory.name) || profile.categories.additionalCategories.some((x) => !/^gcid:[a-z0-9_]+$/i.test(x.name)))) ||
      Boolean(addressChanged && addressHasData && (!profile.storefrontAddress.addressLines.some((line) => line.trim()) || !/^[A-Z]{2}$/.test(profile.storefrontAddress.regionCode)));
    if (invalid) { setError("Review the business name, contact numbers, website, category IDs, and complete storefront address before publishing."); return; }
    setBusy(true); setError(""); setValidationIssues([]); setMessage("");
    try {
      const response = await fetch(`/api/business/${encodeURIComponent(businessId)}/google-profile`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, fingerprint, confirm: confirmed }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        if (data.code === "google_write_uncertain") {
          setConfirmed(false); setRequiresReload(true); setMessageTone("warning"); setMessage(data.message || "Google may have received the update. Reload the profile before trying again."); return;
        }
        if (data.code === "profile_conflict" && data.profile && data.fingerprint) {
          setProfile(data.profile); setBefore(data.profile); setFingerprint(data.fingerprint);
        }
        if (Array.isArray(data.issues)) setValidationIssues(data.issues.filter((item: unknown): item is { field: string; message: string } => Boolean(item && typeof item === "object" && typeof (item as { field?: unknown }).field === "string" && typeof (item as { message?: unknown }).message === "string")));
        throw new Error(data.message || "Google profile update failed.");
      }
      if (data.profile) { setProfile(data.profile); setBefore(data.profile); setFingerprint(data.fingerprint || fingerprint); setRegularText(JSON.stringify(data.profile.regularHours.periods, null, 2)); setSpecialText(JSON.stringify(data.profile.specialHours.specialHourPeriods, null, 2)); }
      setConfirmed(false);
      setRegularJsonError(""); setSpecialJsonError("");
      setMessageTone(data.verified === false ? "warning" : "success");
      setMessage(data.message || "Google profile update completed.");
    } catch (err) { setError(err instanceof Error ? err.message : "Google profile update failed."); }
    finally { setBusy(false); }
  }

  function update<K extends keyof Profile>(key: K, value: Profile[K]) { setProfile((p) => ({ ...p, [key]: value })); }
  function changed(key: keyof Profile) { return Boolean(before && JSON.stringify(profile[key]) !== JSON.stringify(before[key])); }
  function field(label: string, value: string, onChange: (value: string) => void, type = "text") {
    return <label className="block text-sm"><span className="font-medium">{label}</span><input className={inputClass} type={type} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
  }

  return <section className="rounded-lg border border-amber-300 bg-white p-5 shadow-sm">
    <h2 className="text-lg font-semibold">Google Business Profile editor</h2>
    <p className="mt-1 text-sm text-zinc-600">Google values are separate from TRONX settings. Coordinates and service-area fields are not editable here.</p>
    <button type="button" disabled={busy} onClick={() => void load()} className="mt-3 rounded-md border px-3 py-2 text-sm disabled:opacity-50">{busy ? "Working…" : "Load current Google profile"}</button>
    {error && <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {validationIssues.length > 0 && <ul role="alert" className="mt-2 list-disc rounded bg-red-50 p-3 pl-8 text-sm text-red-800">{validationIssues.map((issue, index) => <li key={`${issue.field}-${index}`}><strong>{issue.field}:</strong> {issue.message}</li>)}</ul>}
    {message && <p role="status" className={`mt-3 rounded p-3 text-sm ${messageTone === "success" ? "bg-emerald-50 text-emerald-900" : messageTone === "warning" ? "bg-amber-50 text-amber-900" : "bg-blue-50 text-blue-900"}`}>{message}</p>}
    {loaded && <div className="mt-4 space-y-5">
      <fieldset disabled={busy} className="space-y-3"><legend className="font-semibold">Business information</legend>
        {field("Business name", profile.title, (v) => update("title", v))}
        {field("Website", profile.websiteUri, (v) => update("websiteUri", v), "url")}
      </fieldset>
      <fieldset disabled={busy} className="space-y-3"><legend className="font-semibold">Contact information</legend>
        {field("Primary phone", profile.phoneNumbers.primaryPhone, (v) => update("phoneNumbers", { ...profile.phoneNumbers, primaryPhone: v }), "tel")}
        <label className="block text-sm"><span className="font-medium">Additional phones (one per line, up to two)</span><textarea className={inputClass} rows={2} value={profile.phoneNumbers.additionalPhones.join("\n")} onChange={(e) => update("phoneNumbers", { ...profile.phoneNumbers, additionalPhones: e.target.value.split("\n").filter(Boolean) })} /></label>
      </fieldset>
      <fieldset disabled={busy} className="space-y-3"><legend className="font-semibold">Address</legend>
        <label className="block text-sm"><span className="font-medium">Street address lines (one per line)</span><textarea className={inputClass} rows={2} value={profile.storefrontAddress.addressLines.join("\n")} onChange={(e) => update("storefrontAddress", { ...profile.storefrontAddress, addressLines: e.target.value.split("\n").filter(Boolean) })} /></label>
        <div className="grid gap-3 sm:grid-cols-2">{field("City / locality", profile.storefrontAddress.locality, (v) => update("storefrontAddress", { ...profile.storefrontAddress, locality: v }))}{field("State / administrative area", profile.storefrontAddress.administrativeArea, (v) => update("storefrontAddress", { ...profile.storefrontAddress, administrativeArea: v }))}{field("Postal code", profile.storefrontAddress.postalCode, (v) => update("storefrontAddress", { ...profile.storefrontAddress, postalCode: v }))}{field("Country code (2 letters)", profile.storefrontAddress.regionCode, (v) => update("storefrontAddress", { ...profile.storefrontAddress, regionCode: v.toUpperCase() }))}</div>
      </fieldset>
      <fieldset disabled={busy} className="space-y-3"><legend className="font-semibold">Business categories</legend>
        {field("Primary category ID (e.g. gcid:restaurant)", profile.categories.primaryCategory.name, (v) => update("categories", { ...profile.categories, primaryCategory: { name: v } }))}
        <label className="block text-sm"><span className="font-medium">Additional category IDs (one per line)</span><textarea className={inputClass} rows={2} value={profile.categories.additionalCategories.map((x) => x.name).join("\n")} onChange={(e) => update("categories", { ...profile.categories, additionalCategories: e.target.value.split("\n").filter(Boolean).map((name) => ({ name })) })} /></label>
      </fieldset>
      <fieldset disabled={busy} className="space-y-3"><legend className="font-semibold">Regular business hours</legend><p className="text-xs text-zinc-600">Enter Google Period JSON. Example: [{'{'}&quot;openDay&quot;:&quot;MONDAY&quot;,&quot;openTime&quot;:{'{'}&quot;hours&quot;:9{'}'},&quot;closeDay&quot;:&quot;MONDAY&quot;,&quot;closeTime&quot;:{'{'}&quot;hours&quot;:17{'}'}{'}'}]. Use one entry per opening period.</p>
        <textarea className={`${inputClass} font-mono`} rows={6} value={regularText} onChange={(e) => { setRegularText(e.target.value); try { const value: unknown = JSON.parse(e.target.value); if (!Array.isArray(value)) throw new Error(); update("regularHours", { periods: value as Array<Record<string, unknown>> }); setRegularJsonError(""); } catch { setRegularJsonError("Regular hours must be a valid JSON array."); } }} />
      </fieldset>
      <fieldset disabled={busy} className="space-y-3"><legend className="font-semibold">Special hours</legend><p className="text-xs text-zinc-600">Enter Google SpecialHourPeriod JSON. Closed dates use closed:true. Google requires regular hours when special hours are set.</p>
        <textarea className={`${inputClass} font-mono`} rows={6} value={specialText} onChange={(e) => { setSpecialText(e.target.value); try { const value: unknown = JSON.parse(e.target.value); if (!Array.isArray(value)) throw new Error(); update("specialHours", { specialHourPeriods: value as Array<Record<string, unknown>> }); setSpecialJsonError(""); } catch { setSpecialJsonError("Special hours must be a valid JSON array."); } }} />
      </fieldset>
      {regularJsonError && <p role="alert" className="text-sm text-red-700">{regularJsonError}</p>}
      {specialJsonError && <p role="alert" className="text-sm text-red-700">{specialJsonError}</p>}
      {before && <div className="rounded-md border bg-zinc-50 p-3"><h3 className="font-semibold">Change summary</h3>{Object.keys(profile).filter((key) => changed(key as keyof Profile)).length === 0 ? <p className="mt-2 text-sm">No changes.</p> : <ul className="mt-2 space-y-2 text-sm">{Object.keys(profile).filter((key) => changed(key as keyof Profile)).map((key) => <li key={key}><strong>{key}</strong><div className="grid gap-2 sm:grid-cols-2"><pre className="overflow-auto rounded bg-white p-2">Before: {JSON.stringify(before[key as keyof Profile])}</pre><pre className="overflow-auto rounded bg-white p-2">After: {JSON.stringify(profile[key as keyof Profile])}</pre></div></li>)}</ul>}</div>}
      {!writesEnabled && <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">Live Google profile writes are disabled by server configuration.</p>}
      {requiresReload && <p role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-900">Reload the current Google profile before attempting another update.</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>I reviewed this change summary and explicitly authorize publishing these changes to Google.</span></label>
      <button type="button" disabled={busy || requiresReload || !confirmed || !writesEnabled || Boolean(regularJsonError || specialJsonError)} onClick={() => void publish()} className="rounded-md bg-amber-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Publishing…" : "Publish confirmed changes to Google"}</button>
    </div>}
  </section>;
}
