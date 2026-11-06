"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import {
  buildLocationIdentityKey,
  dedupeLocationsByIdentity,
} from "@/lib/location/identity";

/** Browser-safe high-entropy key for one onboarding attempt. */
function newOnboardingIdempotencyKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

type GroupOption = {
  id: string;
  name: string;
  orgId: string;
  active?: boolean;
  businessCount?: number;
};

type LocationOption = {
  id: string;
  title: string;
  address: string;
  orgId: string;
  googleLocationName: string;
  identityKey: string;
  assigned: boolean;
  assignedBusinessName: string | null;
  selectability?: string;
  selectable?: boolean;
};

type OnboardingSuccess = {
  business: {
    id: string;
    name: string;
    groupId: string | null;
    locationIds: string[];
  };
  group: { id: string; name: string } | null;
  location: {
    id: string;
    title: string;
    googleLocationName: string;
    verificationStatus: string;
  };
  reassignedFrom: { businessId: string; businessName: string } | null;
};

type Step = "business" | "group" | "location" | "review" | "done";

export function AdminOnboardingWizard() {
  const [step, setStep] = useState<Step>("business");
  const [name, setName] = useState("");
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [groupId, setGroupId] = useState("");
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [locationQuery, setLocationQuery] = useState("");
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState("");
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [confirmReassign, setConfirmReassign] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    currentBusinessName: string;
    currentBusinessId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OnboardingSuccess | null>(null);
  /** Stable for one logical submit; never regenerated after a failed attempt. */
  const idempotencyKeyRef = useRef<string | null>(null);
  const submitLockRef = useRef(false);

  const selectedLocation =
    locations.find((l) => l.id === locationId) || null;
  const selectedGroup = groups.find((g) => g.id === groupId) || null;

  const loadGroups = useCallback(async () => {
    setGroupsError(null);
    try {
      const res = await fetch("/api/admin/groups", {
        credentials: "same-origin",
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        groups?: GroupOption[];
      };
      if (!res.ok || !data.success) {
        setGroupsError(data.message || "Could not load groups.");
        return;
      }
      setGroups((data.groups || []).filter((g) => g.active !== false));
    } catch {
      setGroupsError("Could not load groups.");
    }
  }, []);

  async function searchLocations() {
    setLocationBusy(true);
    setLocationError(null);
    try {
      const params = new URLSearchParams({
        q: locationQuery.trim(),
        includeAssigned: "1",
        limit: "80",
        offset: "0",
      });
      const res = await fetch(`/api/admin/locations?${params}`, {
        credentials: "same-origin",
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        locations?: Array<{
          id: string;
          title: string;
          address: string;
          orgId: string;
          googleLocationName: string;
          identityKey?: string;
          assigned?: boolean;
          assignedBusinessName?: string | null;
          selectability?: string;
          selectable?: boolean;
        }>;
      };
      if (!res.ok || !data.success) {
        setLocationError(data.message || "Could not search locations.");
        setLocations([]);
        return;
      }
      const mapped: LocationOption[] = [];
      for (const loc of data.locations || []) {
        const identityKey =
          loc.identityKey ||
          buildLocationIdentityKey(loc.orgId, loc.googleLocationName) ||
          "";
        if (!identityKey) continue;
        mapped.push({
          id: loc.id,
          title: loc.title || "",
          address: loc.address || "",
          orgId: loc.orgId,
          googleLocationName: loc.googleLocationName,
          identityKey,
          assigned: Boolean(loc.assigned),
          assignedBusinessName: loc.assignedBusinessName || null,
          selectability: loc.selectability,
          selectable: loc.selectable,
        });
      }
      const { unique } = dedupeLocationsByIdentity(mapped);
      setLocations(unique as LocationOption[]);
    } catch {
      setLocationError("Could not search locations.");
    } finally {
      setLocationBusy(false);
    }
  }

  function goNextFromBusiness() {
    setError(null);
    if (!name.trim()) {
      setError("Enter an internal business name.");
      return;
    }
    setStep("group");
    void loadGroups();
  }

  function goNextFromGroup() {
    setError(null);
    if (!groupId) {
      setError("Select a group explicitly. Relationships are never inferred.");
      return;
    }
    setStep("location");
  }

  function goNextFromLocation() {
    setError(null);
    setConflict(null);
    if (!locationId) {
      setError("Select a Google location explicitly.");
      return;
    }
    if (selectedLocation?.assigned && !confirmReassign) {
      setError(
        `Location is assigned to ${
          selectedLocation.assignedBusinessName || "another business"
        }. Check “Confirm reassignment” to move it explicitly.`
      );
      return;
    }
    // New logical attempt when arriving at review — keep this key across retries.
    idempotencyKeyRef.current = newOnboardingIdempotencyKey();
    setStep("review");
  }

  async function confirmOnboarding() {
    // UI double-submit guard — server idempotency is still authoritative.
    if (busy || submitLockRef.current) return;
    submitLockRef.current = true;
    setBusy(true);
    setError(null);
    setConflict(null);
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = newOnboardingIdempotencyKey();
    }
    const idempotencyKey = idempotencyKeyRef.current;
    try {
      const res = await fetch("/api/admin/onboarding", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          name: name.trim(),
          groupId,
          locationId,
          idempotencyKey,
          confirmReassign:
            selectedLocation?.assigned || confirmReassign
              ? confirmReassign
              : false,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        code?: string;
        conflict?: {
          currentBusinessName: string;
          currentBusinessId: string;
        };
        business?: OnboardingSuccess["business"];
        group?: OnboardingSuccess["group"];
        location?: OnboardingSuccess["location"];
        reassignedFrom?: OnboardingSuccess["reassignedFrom"];
        reusedIdempotentResult?: boolean;
      };
      if (!res.ok || !data.success) {
        if (data.code === "location_already_assigned" && data.conflict) {
          setConflict(data.conflict);
          setConfirmReassign(false);
          setStep("location");
        }
        // Keep the same idempotencyKey for retries of this attempt.
        setError(data.message || "Onboarding failed.");
        return;
      }
      setResult({
        business: data.business!,
        group: data.group || null,
        location: data.location!,
        reassignedFrom: data.reassignedFrom || null,
      });
      setStep("done");
      idempotencyKeyRef.current = null;
    } catch {
      setError("Network error during onboarding.");
    } finally {
      setBusy(false);
      submitLockRef.current = false;
    }
  }

  if (step === "done" && result) {
    return (
      <section className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium text-zinc-900">
          Onboarding complete
        </h2>
        <p className="text-sm text-zinc-600">
          Explicit assignment saved. Verification status was not changed.
        </p>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-zinc-500">Business</dt>
            <dd className="font-medium text-zinc-900">
              {result.business.name}{" "}
              <span className="font-mono text-xs text-zinc-500">
                {result.business.id}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Group</dt>
            <dd className="text-zinc-900">
              {result.group?.name || "—"}{" "}
              <span className="font-mono text-xs text-zinc-500">
                {result.group?.id}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Google location</dt>
            <dd>
              <span className="font-medium">
                {result.location.title || result.location.googleLocationName}
              </span>
              <span className="mt-1 block break-all font-mono text-xs text-zinc-600">
                {result.location.googleLocationName}
              </span>
              <span className="mt-1 block text-xs text-zinc-600">
                Verification: {result.location.verificationStatus} (unchanged by
                assignment)
              </span>
            </dd>
          </div>
          {result.reassignedFrom && (
            <div>
              <dt className="text-zinc-500">Moved from</dt>
              <dd className="text-amber-900">
                {result.reassignedFrom.businessName} (
                {result.reassignedFrom.businessId})
              </dd>
            </div>
          )}
        </dl>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="underline" href="/admin/businesses">
            Businesses
          </Link>
          <Link
            className="underline"
            href={`/gmb/locations/${encodeURIComponent(result.location.id)}`}
          >
            Location detail
          </Link>
          <Link className="underline" href="/admin/groups">
            Groups
          </Link>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setName("");
              setGroupId("");
              setLocationId("");
              setConfirmReassign(false);
              setResult(null);
              setConflict(null);
              setError(null);
              setStep("business");
            }}
          >
            Onboard another
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5">
      <div>
        <h2 className="text-lg font-medium text-zinc-900">
          Business · group · Google location onboarding
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Super Admin only. Never auto-links by name or address. Step:{" "}
          <span className="font-medium">{step}</span>
        </p>
      </div>

      <ol className="flex flex-wrap gap-2 text-xs text-zinc-600">
        {(["business", "group", "location", "review"] as Step[]).map((s) => (
          <li
            key={s}
            className={`rounded px-2 py-1 ${
              step === s ? "bg-zinc-900 text-white" : "bg-zinc-100"
            }`}
          >
            {s}
          </li>
        ))}
      </ol>

      {step === "business" && (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="font-medium">Internal business name</span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <button
            type="button"
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white"
            onClick={goNextFromBusiness}
          >
            Continue to group
          </button>
        </div>
      )}

      {step === "group" && (
        <div className="space-y-3">
          {groupsError && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {groupsError}
            </p>
          )}
          <label className="block text-sm">
            <span className="font-medium">Business group (required)</span>
            <select
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              <option value="">Select a group…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.businessCount ?? 0} businesses)
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-zinc-500">
            Need a group first?{" "}
            <Link className="underline" href="/admin/groups">
              Create one under Groups
            </Link>
            , then refresh this page.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
              onClick={() => setStep("business")}
            >
              Back
            </button>
            <button
              type="button"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
              onClick={() => void loadGroups()}
            >
              Refresh groups
            </button>
            <button
              type="button"
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white"
              onClick={goNextFromGroup}
            >
              Continue to location
            </button>
          </div>
        </div>
      )}

      {step === "location" && (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600">
            Link an existing discovered location, or{" "}
            <Link className="underline" href="/gmb/locations/create">
              create a new Google location
            </Link>{" "}
            first (stays unassigned until you finish this wizard).
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              className="min-w-[12rem] flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="Search locations by name or address"
              value={locationQuery}
              onChange={(e) => setLocationQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void searchLocations();
                }
              }}
            />
            <button
              type="button"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
              disabled={locationBusy}
              onClick={() => void searchLocations()}
            >
              {locationBusy ? "Searching…" : "Search"}
            </button>
          </div>
          {locationError && (
            <p className="text-sm text-red-800">{locationError}</p>
          )}
          <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
            {locations.map((loc) => {
              const needsMove = loc.assigned;
              return (
                <li key={loc.identityKey}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-50">
                    <input
                      type="radio"
                      name="onboard-location"
                      className="mt-1"
                      checked={locationId === loc.id}
                      onChange={() => {
                        setLocationId(loc.id);
                        setConfirmReassign(false);
                        setConflict(null);
                      }}
                    />
                    <span>
                      <span className="font-medium">
                        {loc.title || loc.googleLocationName}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-600">
                        {loc.address || "Address unavailable"}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-zinc-500">
                        {loc.googleLocationName}
                      </span>
                      <span
                        className={`mt-1 inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${
                          needsMove
                            ? "bg-amber-100 text-amber-950"
                            : "bg-emerald-100 text-emerald-950"
                        }`}
                      >
                        {needsMove
                          ? `Assigned · ${loc.assignedBusinessName || "business"}`
                          : "Available"}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {selectedLocation?.assigned && (
            <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmReassign}
                onChange={(e) => setConfirmReassign(e.target.checked)}
              />
              <span>
                Confirm explicit reassignment from{" "}
                <strong>
                  {selectedLocation.assignedBusinessName ||
                    conflict?.currentBusinessName ||
                    "the current business"}
                </strong>
                . Existing assignment will be cleared only after you confirm the
                final review step.
              </span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
              onClick={() => setStep("group")}
            >
              Back
            </button>
            <button
              type="button"
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white"
              onClick={goNextFromLocation}
            >
              Review assignment
            </button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600">
            Confirm before saving. Nothing is inferred from names or addresses.
          </p>
          <pre className="overflow-x-auto rounded-md bg-zinc-50 p-3 text-xs text-zinc-800">
            {JSON.stringify(
              {
                businessName: name.trim(),
                group: selectedGroup
                  ? { id: selectedGroup.id, name: selectedGroup.name }
                  : null,
                location: selectedLocation
                  ? {
                      id: selectedLocation.id,
                      title: selectedLocation.title,
                      googleLocationName: selectedLocation.googleLocationName,
                      currentlyAssigned: selectedLocation.assigned,
                      assignedBusinessName:
                        selectedLocation.assignedBusinessName,
                    }
                  : null,
                confirmReassign: Boolean(
                  selectedLocation?.assigned && confirmReassign
                ),
              },
              null,
              2
            )}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
              disabled={busy}
              onClick={() => setStep("location")}
            >
              Back
            </button>
            <button
              type="button"
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void confirmOnboarding()}
            >
              {busy ? "Saving…" : "Confirm and save assignment"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </section>
  );
}
