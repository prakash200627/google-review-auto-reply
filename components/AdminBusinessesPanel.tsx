"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminAutoPublishPanel } from "@/components/AdminAutoPublishPanel";
import { AdminBusinessOpsPanel } from "@/components/AdminBusinessOpsPanel";
import { AdminPermanentDeleteDialog } from "@/components/AdminPermanentDeleteDialog";
import {
  buildLocationIdentityKey,
  dedupeLocationsByIdentity,
  locationListKey,
} from "@/lib/location/identity";

type PlanSnapshot = {
  code: string;
  displayName: string;
  status: string;
  limits?: { monthlyAiDraftQuota?: number };
  usage?: { aiDraftsThisPeriod?: number };
};

type BusinessLifecycleStatus = "active" | "suspended" | "archived";

type BusinessRow = {
  id: string;
  name: string;
  active: boolean;
  status?: BusinessLifecycleStatus;
  replyMode: string;
  brandVoice?: string;
  preferredLanguage?: string;
  locationIds: string[];
  reviewCount?: number;
  ownerEmail?: string | null;
  ownerActive?: boolean | null;
  ownerUserId?: string | null;
  orgId?: string;
  plan?: PlanSnapshot | null;
};

function resolveRowStatus(biz: BusinessRow): BusinessLifecycleStatus {
  if (biz.status === "active" || biz.status === "suspended" || biz.status === "archived") {
    return biz.status;
  }
  return biz.active === false ? "suspended" : "active";
}

type UnassignedLocation = {
  id: string;
  title: string;
  address: string;
  addressUnavailable?: boolean;
  orgId: string;
  googleLocationName: string;
  identityKey?: string;
};

type LocationSelectability =
  | "available"
  | "already_assigned"
  | "no_usable_connection";

type SearchableLocation = {
  id: string;
  title: string;
  address: string;
  addressUnavailable?: boolean;
  orgId: string;
  googleLocationName: string;
  identityKey: string;
  assigned: boolean;
  assignedBusinessName: string | null;
  selectability?: LocationSelectability;
  selectable?: boolean;
  connection: {
    status: string;
    email: string;
    connectionSource: string;
  } | null;
};

function toSearchableLocation(
  loc: UnassignedLocation | SearchableLocation
): SearchableLocation | null {
  const identityKey =
    (typeof loc.identityKey === "string" &&
    !loc.identityKey.includes("undefined")
      ? loc.identityKey
      : null) ||
    buildLocationIdentityKey(loc.orgId, loc.googleLocationName);
  if (!identityKey) return null;
  const address =
    typeof loc.address === "string" && loc.address.trim()
      ? loc.address.trim()
      : "";
  return {
    id: loc.id,
    title: loc.title,
    address,
    addressUnavailable:
      typeof (loc as SearchableLocation).addressUnavailable === "boolean"
        ? (loc as SearchableLocation).addressUnavailable
        : !address,
    orgId: loc.orgId,
    googleLocationName: String(loc.googleLocationName),
    identityKey,
    assigned: "assigned" in loc ? Boolean(loc.assigned) : false,
    assignedBusinessName:
      "assignedBusinessName" in loc ? loc.assignedBusinessName || null : null,
    selectability:
      "selectability" in loc && loc.selectability
        ? loc.selectability
        : "available",
    selectable:
      "selectable" in loc && typeof loc.selectable === "boolean"
        ? loc.selectable
        : true,
    connection: "connection" in loc ? loc.connection || null : null,
  };
}

function seedLocationResults(
  initialUnassigned: UnassignedLocation[]
): SearchableLocation[] {
  const mapped = initialUnassigned
    .map((loc) => toSearchableLocation(loc))
    .filter((row): row is SearchableLocation => row != null);
  const { unique } = dedupeLocationsByIdentity(mapped);
  return unique as SearchableLocation[];
}

function locationStatusLabel(loc: SearchableLocation): string {
  const sel =
    loc.selectability ||
    (loc.assigned
      ? "already_assigned"
      : loc.connection?.status === "active"
        ? "available"
        : "no_usable_connection");
  if (sel === "already_assigned") {
    return loc.assignedBusinessName
      ? `Already assigned · ${loc.assignedBusinessName}`
      : "Already assigned";
  }
  if (sel === "no_usable_connection") return "No usable Google connection";
  return "Available";
}

function isLocationSelectable(loc: SearchableLocation): boolean {
  if (typeof loc.selectable === "boolean") return loc.selectable;
  return (
    !loc.assigned &&
    loc.connection?.status === "active" &&
    loc.selectability !== "already_assigned" &&
    loc.selectability !== "no_usable_connection"
  );
}

const BRAND_OPTIONS = [
  "friendly",
  "professional",
  "casual",
  "premium",
  "empathetic",
  "concise",
] as const;

export function AdminBusinessesPanel({
  initialBusinesses,
  initialUnassigned,
  defaultOrgId,
}: {
  initialBusinesses: BusinessRow[];
  initialUnassigned: UnassignedLocation[];
  defaultOrgId: string | null;
}) {
  const router = useRouter();
  const [businesses, setBusinesses] = useState(initialBusinesses);
  const [unassigned, setUnassigned] = useState(initialUnassigned);
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState(defaultOrgId || "");
  const [orgOptions, setOrgOptions] = useState<
    Array<{ id: string; name: string; email: string }>
  >([]);
  const [replyMode, setReplyMode] = useState<"manual" | "auto">("manual");
  const [brandVoice, setBrandVoice] =
    useState<(typeof BRAND_OPTIONS)[number]>("friendly");
  const [preferredLanguage, setPreferredLanguage] = useState("English");
  /** At most one Google location per business — resolved server-side. */
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [locationQuery, setLocationQuery] = useState("");
  const [locationResults, setLocationResults] = useState<SearchableLocation[]>(
    () => seedLocationResults(initialUnassigned)
  );
  const [locationSearchBusy, setLocationSearchBusy] = useState(false);
  const [locationSearchError, setLocationSearchError] = useState<string | null>(
    null
  );
  const [locationSearchDone, setLocationSearchDone] = useState(false);
  const [locationHasMore, setLocationHasMore] = useState(false);
  const [locationOffset, setLocationOffset] = useState(0);
  const [locationTotalMatched, setLocationTotalMatched] = useState(() =>
    seedLocationResults(initialUnassigned).length
  );
  const [locationMetaNote, setLocationMetaNote] = useState<string | null>(null);
  const [planCode, setPlanCode] = useState("starter");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBrand, setEditBrand] =
    useState<(typeof BRAND_OPTIONS)[number]>("friendly");
  const [editLanguage, setEditLanguage] = useState("English");
  const [editLocationId, setEditLocationId] = useState<string>("");
  const [editPlanCode, setEditPlanCode] = useState("starter");
  const [editPlanStatus, setEditPlanStatus] = useState("active");
  const [editOwnerEmail, setEditOwnerEmail] = useState("");
  const [editOwnerPassword, setEditOwnerPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const searchLocations = useCallback(
    async (q: string, options: { offset?: number; append?: boolean } = {}) => {
      const offset = options.offset ?? 0;
      const append = Boolean(options.append);
      setLocationSearchBusy(true);
      setLocationSearchError(null);
      setLocationSearchDone(true);
      try {
        const params = new URLSearchParams({
          q: q.trim(),
          includeAssigned: "1",
          limit: "80",
          offset: String(offset),
        });
        const res = await fetch(`/api/admin/locations?${params.toString()}`);
        const data = (await res.json()) as {
          success?: boolean;
          locations?: SearchableLocation[];
          message?: string;
          hasMore?: boolean;
          totalMatched?: number;
          offset?: number;
          note?: string;
          skippedInvalid?: number;
        };
        if (!res.ok || !data.success) {
          const msg = data.message || "Could not search locations";
          setLocationSearchError(msg);
          setError(msg);
          return;
        }
        const nextRows = (data.locations || [])
          .map((loc) => toSearchableLocation(loc))
          .filter((row): row is SearchableLocation => row != null);

        let merged: SearchableLocation[] = nextRows;
        setLocationResults((prev) => {
          const { unique } = dedupeLocationsByIdentity(
            append ? [...prev, ...nextRows] : nextRows
          );
          merged = unique as SearchableLocation[];
          return merged;
        });
        setLocationHasMore(Boolean(data.hasMore));
        setLocationOffset(
          typeof data.offset === "number"
            ? data.offset + nextRows.length
            : offset + nextRows.length
        );
        setLocationTotalMatched(
          typeof data.totalMatched === "number"
            ? data.totalMatched
            : merged.length
        );
        setLocationMetaNote(
          [
            data.note,
            data.skippedInvalid
              ? `${data.skippedInvalid} cache row(s) skipped (missing Google location id).`
              : null,
          ]
            .filter(Boolean)
            .join(" ") || null
        );
        setSelectedLocationId((prev) => {
          if (!prev) return prev;
          const next = merged.find((l) => l.id === prev);
          if (!next || !isLocationSelectable(next)) return "";
          return prev;
        });
      } catch {
        const msg = "Could not search locations";
        setLocationSearchError(msg);
        setError(msg);
      } finally {
        setLocationSearchBusy(false);
      }
    },
    []
  );

  const selectedLocation =
    locationResults.find((l) => l.id === selectedLocationId) || null;

  /** When an active org is selected, hide businesses from other orgs in the list. */
  const scopedBusinesses = useMemo(() => {
    const active = orgId.trim();
    if (!active) return businesses;
    return businesses.filter((b) => b.orgId === active);
  }, [businesses, orgId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/organizations");
        const data = (await res.json()) as {
          success?: boolean;
          organizations?: Array<{ id: string; name: string; email: string }>;
          activeOrgId?: string | null;
        };
        if (cancelled || !res.ok || !data.success) return;
        // Only populate options here. Do not sync orgId from the response during
        // mount — defaultOrgId from the server already seeds controlled state and
        // avoids a client/server tree mismatch after hydration.
        setOrgOptions(data.organizations || []);
        if (!defaultOrgId && data.activeOrgId) {
          setOrgId((prev) => prev || data.activeOrgId || "");
        }
      } catch {
        /* org picker is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defaultOrgId]);

  function submitLocationSearch(e?: React.FormEvent) {
    e?.preventDefault();
    setLocationOffset(0);
    void searchLocations(locationQuery, { offset: 0, append: false });
  }

  function loadMoreLocations() {
    void searchLocations(locationQuery, {
      offset: locationOffset,
      append: true,
    });
  }

  async function selectActiveOrganization() {
    if (!orgId.trim()) {
      setError("Enter an organization id to set as the active Google workspace.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/organizations/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: orgId.trim() }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not select organization");
        return;
      }
      setMessage(
        data.message ||
          "Active Google workspace updated (server-signed cookie)."
      );
      // Drop previous-org location caches immediately, then reload against the
      // new signed cookie so Admin / ORM / GMB share one org context.
      setSelectedLocationId("");
      setLocationResults([]);
      setUnassigned([]);
      setLocationTotalMatched(0);
      setLocationMetaNote(null);
      await refreshLists();
      router.refresh();
    } catch {
      setError("Could not select organization");
    } finally {
      setBusy(false);
    }
  }

  async function refreshLists() {
    const [bizRes, locRes] = await Promise.all([
      fetch("/api/admin/businesses"),
      fetch("/api/admin/locations/unassigned?limit=80&offset=0"),
    ]);
    const bizData = (await bizRes.json()) as {
      success?: boolean;
      businesses?: BusinessRow[];
    };
    const locData = (await locRes.json()) as {
      success?: boolean;
      locations?: UnassignedLocation[];
      message?: string;
    };
    if (bizData.success && bizData.businesses) setBusinesses(bizData.businesses);
    if (locRes.ok && locData.success && locData.locations) {
      setUnassigned(seedLocationResults(locData.locations));
    }
    await searchLocations(locationQuery, { offset: 0, append: false });
  }

  async function createBusiness(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedLocationId) {
      setError("Select a Google Business Profile location to create a business.");
      return;
    }
    if (selectedLocation && !isLocationSelectable(selectedLocation)) {
      setError(
        selectedLocation.selectability === "already_assigned" ||
          selectedLocation.assigned
          ? `Location is already assigned${
              selectedLocation.assignedBusinessName
                ? ` to ${selectedLocation.assignedBusinessName}`
                : ""
            }. Unassign it first.`
          : "Selected location has no usable Google connection. Connect Google under GMB → Connection, discover under GMB → Locations, then retry."
      );
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          locationId: selectedLocationId,
          replyMode,
          brandVoice,
          preferredLanguage,
          planCode,
          ownerEmail: ownerEmail || undefined,
          ownerPassword: ownerPassword || undefined,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not create business");
        return;
      }
      setMessage(data.message || "Business created");
      setName("");
      setSelectedLocationId("");
      setPlanCode("starter");
      setOwnerEmail("");
      setOwnerPassword("");
      setReplyMode("manual");
      setBrandVoice("friendly");
      setPreferredLanguage("English");
      await refreshLists();
    } catch {
      setError("Could not create business");
    } finally {
      setBusy(false);
    }
  }

  async function patchBusiness(
    id: string,
    patch: Record<string, unknown>
  ) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/businesses/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Update failed");
        return;
      }
      setMessage(data.message || "Updated");
      setEditingId(null);
      await refreshLists();
    } catch {
      setError("Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function setOwnerActive(userId: string, active: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/owners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_active", userId, active }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Owner update failed");
        return;
      }
      setMessage(data.message || "Owner updated");
      await refreshLists();
    } catch {
      setError("Owner update failed");
    } finally {
      setBusy(false);
    }
  }

  async function resetOwnerPassword(userId: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/owners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset_password",
          userId,
          newPassword,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Password reset failed");
        return;
      }
      setMessage(
        data.message ||
          "Password reset. Share the new password out-of-band (no email is sent)."
      );
      setEditOwnerPassword("");
      await refreshLists();
    } catch {
      setError("Password reset failed");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(biz: BusinessRow) {
    setEditingId(biz.id);
    setEditName(biz.name);
    setEditBrand(
      (BRAND_OPTIONS.includes(biz.brandVoice as never)
        ? biz.brandVoice
        : "friendly") as (typeof BRAND_OPTIONS)[number]
    );
    setEditLanguage(biz.preferredLanguage || "English");
    setEditLocationId((biz.locationIds || [])[0] || "");
    setEditPlanCode(biz.plan?.code || "starter");
    setEditPlanStatus(biz.plan?.status || "active");
    setEditOwnerEmail(biz.ownerEmail || "");
    setEditOwnerPassword("");
  }

  const editingBiz =
    businesses.find((b) => b.id === editingId) || null;
  const editAssignable = (() => {
    const byId = new Map(unassigned.map((l) => [l.id, l]));
    // Keep currently assigned locations selectable even when not in the
    // unassigned search cache (otherwise Save can drop the assignment).
    if (editingBiz) {
      for (const id of editingBiz.locationIds || []) {
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            title: `(Assigned) ${editingBiz.name}`,
            address: "",
            orgId: editingBiz.orgId || "",
            googleLocationName: id,
          });
        }
      }
    }
    return [...byId.values()];
  })();

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight">Create business</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Search and select one Google Business Profile location. The server
          resolves the organization and Google connection from that location —
          do not paste organization ids. Locations come from prior discovery
          under Reviews (not invented here). Passwords are required only for
          new owner accounts; linking never changes passwords.
        </p>
        <form onSubmit={(e) => void createBusiness(e)} className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="font-medium">Business display name</span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <fieldset className="rounded-md border border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-600 dark:bg-zinc-900/40">
            <legend className="px-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Google Business Profile location
            </legend>
            <p id="location-search-hint" className="mb-2 text-sm text-zinc-700 dark:text-zinc-300">
              Search runs only when you click Search or press Enter. Results come
              from the MongoDB discovery cache — not live Google.
            </p>
            <div
              role="search"
              className="flex flex-wrap gap-2"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitLocationSearch();
                }
              }}
            >
              <label className="sr-only" htmlFor="gbp-location-search">
                Search Google locations by name or address
              </label>
              <input
                id="gbp-location-search"
                className="min-w-[12rem] flex-1 rounded-md border border-zinc-400 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-600 dark:border-zinc-500 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-400"
                placeholder="Search by name or address"
                value={locationQuery}
                onChange={(e) => setLocationQuery(e.target.value)}
                aria-describedby="location-search-hint location-search-status"
                autoComplete="off"
              />
              <button
                type="button"
                disabled={locationSearchBusy}
                onClick={() => submitLocationSearch()}
                className="rounded-md border border-zinc-500 bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                {locationSearchBusy ? "Searching…" : "Search"}
              </button>
            </div>
            <div
              id="location-search-status"
              className="mt-2 text-sm text-zinc-800 dark:text-zinc-200"
              aria-live="polite"
            >
              {!defaultOrgId
                ? "Select an active Google workspace (below) before searching locations. Results are scoped to that organization only."
                : locationSearchBusy
                  ? "Loading locations…"
                  : locationSearchError
                    ? locationSearchError
                    : locationSearchDone && locationResults.length === 0
                      ? "No valid stored locations match in this organization. Connect Google under GMB → Connection, then Discover locations under GMB → Locations (Super Admin)."
                      : locationResults.length > 0
                        ? `Showing ${locationResults.length} of ${locationTotalMatched} distinct location${locationTotalMatched === 1 ? "" : "s"} in the active organization.`
                        : "Use Search to load matching locations from the cache for the active organization."}
            </div>
            {locationMetaNote && (
              <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">
                {locationMetaNote}
              </p>
            )}
            {locationResults.length > 0 && (
              <>
                <ul
                  className="mt-2 max-h-56 space-y-1 overflow-y-auto text-sm"
                  role="radiogroup"
                  aria-label="Google Business Profile locations"
                >
                  {locationResults.map((loc) => {
                    const disabled = !isLocationSelectable(loc);
                    const status = locationStatusLabel(loc);
                    const rowKey =
                      locationListKey(loc.identityKey, loc.id) ||
                      loc.identityKey;
                    const optionId = `create-loc-${loc.id}`;
                    return (
                      <li key={rowKey}>
                        <label
                          htmlFor={optionId}
                          className={`flex cursor-pointer items-start gap-2 rounded-md border border-transparent px-2 py-1.5 ${
                            disabled
                              ? "cursor-not-allowed bg-zinc-100/80 text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300"
                              : "hover:border-zinc-300 hover:bg-white dark:hover:border-zinc-500 dark:hover:bg-zinc-950"
                          }`}
                        >
                          <input
                            id={optionId}
                            type="radio"
                            name="create-location"
                            value={loc.id}
                            className="mt-1 h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
                            checked={selectedLocationId === loc.id}
                            disabled={disabled}
                            onChange={() => setSelectedLocationId(loc.id)}
                            aria-describedby={`${optionId}-desc`}
                          />
                          <span id={`${optionId}-desc`}>
                            <span className="font-semibold text-zinc-900 dark:text-zinc-50">
                              {loc.title || loc.googleLocationName}
                            </span>
                            {loc.address ? (
                              <span className="mt-0.5 block text-zinc-700 dark:text-zinc-300">
                                {loc.address}
                              </span>
                            ) : (
                              <span className="mt-0.5 block text-zinc-700 dark:text-zinc-300">
                                Address unavailable from Google (identity is
                                still valid)
                              </span>
                            )}
                            <span className="mt-0.5 block font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                              {loc.googleLocationName}
                            </span>
                            <span
                              className={`mt-1 inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${
                                status.startsWith("Available")
                                  ? "bg-emerald-100 text-emerald-950 dark:bg-emerald-900 dark:text-emerald-50"
                                  : status.startsWith("Already")
                                    ? "bg-amber-100 text-amber-950 dark:bg-amber-900 dark:text-amber-50"
                                    : "bg-red-100 text-red-950 dark:bg-red-900 dark:text-red-50"
                              }`}
                            >
                              {status}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {locationHasMore && (
                  <button
                    type="button"
                    disabled={locationSearchBusy}
                    onClick={() => loadMoreLocations()}
                    className="mt-2 rounded-md border border-zinc-400 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50 dark:border-zinc-500 dark:text-zinc-100"
                  >
                    {locationSearchBusy ? "Loading…" : "Load more locations"}
                  </button>
                )}
              </>
            )}
            {selectedLocation && (
              <p className="mt-2 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100">
                Selected {selectedLocation.identityKey}. Status:{" "}
                {locationStatusLabel(selectedLocation)}
                {selectedLocation.connection?.email
                  ? ` · ${selectedLocation.connection.email}`
                  : ""}
              </p>
            )}
          </fieldset>
          <details className="rounded-md border border-zinc-200 p-3 text-sm">
            <summary className="cursor-pointer font-medium">
              Advanced: active Google workspace cookie (discovery only)
            </summary>
            <p className="mt-2 text-xs text-zinc-500">
              Used for location discovery under Reviews. Prefer the organization
              dropdown; paste an id only if needed.
            </p>
            {orgOptions.length > 0 && (
              <select
                className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                value={orgOptions.some((o) => o.id === orgId) ? orgId : ""}
                onChange={(e) => setOrgId(e.target.value)}
                aria-label="Organization for workspace cookie"
              >
                <option value="">Select organization…</option>
                {orgOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || o.email || o.id}
                  </option>
                ))}
              </select>
            )}
            <input
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              aria-label="Organization id for workspace cookie"
              placeholder="Organization ObjectId"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void selectActiveOrganization()}
              className="mt-2 rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
            >
              Set active Google workspace (signed cookie)
            </button>
          </details>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium">Brand voice</span>
              <select
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={brandVoice}
                onChange={(e) =>
                  setBrandVoice(e.target.value as (typeof BRAND_OPTIONS)[number])
                }
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
                value={preferredLanguage}
                onChange={(e) => setPreferredLanguage(e.target.value)}
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium">Reply mode</span>
              <select
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={replyMode}
                onChange={(e) =>
                  setReplyMode(e.target.value === "auto" ? "auto" : "manual")
                }
              >
                <option value="manual">
                  Manual — drafts require explicit Publish confirmation
                </option>
                <option value="auto">
                  Auto preference (stored only; automatic publishing is NOT active)
                </option>
              </select>
              <p className="mt-1 text-xs text-amber-800">
                Choosing Auto only saves a preference. This Next.js app does not
                automatically publish replies. Manual confirmation remains required.
              </p>
            </label>
            <label className="block text-sm">
              <span className="font-medium">Plan (manual assignment)</span>
              <select
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value)}
              >
                <option value="free">Free</option>
                <option value="starter">Starter</option>
                <option value="growth">Growth</option>
                <option value="custom">Custom</option>
              </select>
              <p className="mt-1 text-xs text-zinc-500">
                No payments — Super Admin assigns plans. Features are enforced
                server-side.
              </p>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium">Owner email (optional)</span>
              <input
                type="email"
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium">
                Owner password (required for new accounts only)
              </span>
              <input
                type="password"
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={busy || !selectedLocationId}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Create business"}
          </button>
        </form>
      </section>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </p>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight">Existing businesses</h2>
        {orgId.trim() ? (
          <p className="mt-1 text-xs text-zinc-500">
            Showing businesses for the active organization only. Location search
            is also org-scoped.
          </p>
        ) : (
          <p className="mt-1 text-xs text-zinc-500">
            Select an active organization to scope this list and Google location
            tools.
          </p>
        )}
        <ul className="mt-4 divide-y divide-zinc-100">
          {scopedBusinesses.length === 0 && (
            <li className="py-3 text-sm text-zinc-600">
              {orgId.trim()
                ? "No businesses in the active organization."
                : "No businesses yet."}
            </li>
          )}
          {scopedBusinesses.map((biz) => (
            <li key={biz.id} className="space-y-3 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-zinc-900">{biz.name}</p>
                  <p className="text-sm text-zinc-600">
                    Business: {resolveRowStatus(biz)}
                    {biz.plan
                      ? ` · Plan: ${biz.plan.displayName} (${biz.plan.status})`
                      : " · Plan: none"}{" "}
                    · preference{" "}
                    {biz.replyMode === "auto"
                      ? "auto (stored only; not publishing)"
                      : "manual"}{" "}
                    ·{" "}
                    {biz.locationIds?.length
                      ? "1 location assigned"
                      : "no location"}{" "}
                    · {biz.reviewCount ?? 0} review(s) · voice{" "}
                    {biz.brandVoice || "friendly"} ·{" "}
                    {biz.preferredLanguage || "English"}
                  </p>
                  <p className="mt-1 text-sm text-zinc-600">
                    Owner:{" "}
                    {biz.ownerEmail
                      ? `${biz.ownerEmail}${
                          biz.ownerActive === false ? " (deactivated)" : ""
                        }`
                      : "none"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/orm?businessId=${encodeURIComponent(biz.id)}`}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                  >
                    Support view
                  </Link>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => startEdit(biz)}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void patchBusiness(biz.id, {
                        replyMode: biz.replyMode === "auto" ? "manual" : "auto",
                      })
                    }
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                    title="Saves a preference only. Automatic publishing is not enabled."
                  >
                    {biz.replyMode === "auto"
                      ? "Set manual preference"
                      : "Store auto preference"}
                  </button>
                  {resolveRowStatus(biz) === "active" && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Suspend "${biz.name}"? Owners lose operational access. Sync, drafts, and publishing stop. Pending auto-reply jobs are cancelled. Plan and owner account stay unchanged.`
                            )
                          ) {
                            return;
                          }
                          void patchBusiness(biz.id, {
                            lifecycleAction: "suspend",
                          });
                        }}
                        className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50"
                      >
                        Suspend
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Archive "${biz.name}"? This is not permanent deletion. Owners lose access; auto-reply is disabled and must be re-enabled separately after restore/reactivate.`
                            )
                          ) {
                            return;
                          }
                          void patchBusiness(biz.id, {
                            lifecycleAction: "archive",
                          });
                        }}
                        className="rounded-md border border-zinc-400 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100"
                      >
                        Archive
                      </button>
                    </>
                  )}
                  {resolveRowStatus(biz) === "suspended" && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void patchBusiness(biz.id, {
                            lifecycleAction: "reactivate",
                          })
                        }
                        className="rounded-md border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-50"
                      >
                        Reactivate
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Archive suspended business "${biz.name}"? Restore later returns it to Suspended only.`
                            )
                          ) {
                            return;
                          }
                          void patchBusiness(biz.id, {
                            lifecycleAction: "archive",
                          });
                        }}
                        className="rounded-md border border-zinc-400 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100"
                      >
                        Archive
                      </button>
                    </>
                  )}
                  {resolveRowStatus(biz) === "archived" && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Restore "${biz.name}" to Suspended? Auto-reply stays disabled. Use Reactivate after restore when ready.`
                            )
                          ) {
                            return;
                          }
                          void patchBusiness(biz.id, {
                            lifecycleAction: "restore",
                          });
                        }}
                        className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setDeleteTarget({ id: biz.id, name: biz.name })
                        }
                        className="rounded-md border border-red-700 bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800"
                        title="Irreversible. Requires archived status and typed confirmations."
                      >
                        Delete permanently
                      </button>
                    </>
                  )}
                  {biz.ownerUserId && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void setOwnerActive(
                          biz.ownerUserId!,
                          biz.ownerActive === false
                        )
                      }
                      className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                    >
                      {biz.ownerActive === false
                        ? "Activate owner"
                        : "Deactivate owner"}
                    </button>
                  )}
                </div>
              </div>

              {editingId === biz.id && (
                <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 space-y-3">
                  <AdminAutoPublishPanel businessId={biz.id} />
                  <AdminBusinessOpsPanel businessId={biz.id} />
                  <label className="block text-sm">
                    <span className="font-medium">Name</span>
                    <input
                      className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm">
                      <span className="font-medium">Brand voice</span>
                      <select
                        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                        value={editBrand}
                        onChange={(e) =>
                          setEditBrand(
                            e.target.value as (typeof BRAND_OPTIONS)[number]
                          )
                        }
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
                        value={editLanguage}
                        onChange={(e) => setEditLanguage(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm">
                      <span className="font-medium">Plan</span>
                      <select
                        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                        value={editPlanCode}
                        onChange={(e) => setEditPlanCode(e.target.value)}
                      >
                        <option value="free">Free</option>
                        <option value="starter">Starter</option>
                        <option value="growth">Growth</option>
                        <option value="custom">Custom</option>
                      </select>
                    </label>
                    <label className="block text-sm">
                      <span className="font-medium">Plan status</span>
                      <select
                        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                        value={editPlanStatus}
                        onChange={(e) => setEditPlanStatus(e.target.value)}
                      >
                        <option value="active">Active</option>
                        <option value="suspended">Suspended</option>
                        <option value="expired">Expired</option>
                      </select>
                    </label>
                  </div>
                  <fieldset>
                    <legend className="text-sm font-medium">
                      Google location (at most one; unassign before reassigning
                      elsewhere)
                    </legend>
                    <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm">
                      <li>
                        <label className="flex items-start gap-2">
                          <input
                            type="radio"
                            name={`edit-location-${biz.id}`}
                            value=""
                            checked={editLocationId === ""}
                            onChange={() => setEditLocationId("")}
                          />
                          <span>Unassigned</span>
                        </label>
                      </li>
                      {[
                        ...editAssignable,
                      ]
                        .filter(
                          (loc, idx, arr) =>
                            arr.findIndex((x) => x.id === loc.id) === idx
                        )
                        .concat(
                          (biz.locationIds || [])
                            .filter(
                              (id) =>
                                !unassigned.some((u) => u.id === id) &&
                                !editAssignable.some((u) => u.id === id)
                            )
                            .map((id) => ({
                              id,
                              title: `(currently assigned) ${id.slice(-6)}`,
                              address: "",
                              orgId: biz.orgId || "",
                              googleLocationName: id,
                            }))
                        )
                        .map((loc) => (
                          <li key={loc.id}>
                            <label className="flex items-start gap-2">
                              <input
                                type="radio"
                                name={`edit-location-${biz.id}`}
                                value={loc.id}
                                checked={editLocationId === loc.id}
                                onChange={() => setEditLocationId(loc.id)}
                              />
                              <span>
                                {loc.title || loc.googleLocationName}
                                {loc.address ? ` — ${loc.address}` : ""}
                              </span>
                            </label>
                          </li>
                        ))}
                    </ul>
                  </fieldset>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm">
                      <span className="font-medium">
                        Owner email (set/reassign)
                      </span>
                      <input
                        type="email"
                        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                        value={editOwnerEmail}
                        onChange={(e) => setEditOwnerEmail(e.target.value)}
                      />
                    </label>
                    <label className="block text-sm">
                      <span className="font-medium">
                        Owner password (new accounts only)
                      </span>
                      <input
                        type="password"
                        className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
                        value={editOwnerPassword}
                        onChange={(e) => setEditOwnerPassword(e.target.value)}
                        autoComplete="new-password"
                        placeholder="Required for new owners; ignored when linking"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const currentLocationId =
                          (biz.locationIds || [])[0] || "";
                        const ownerChanged =
                          Boolean(editOwnerEmail.trim()) &&
                          editOwnerEmail.trim().toLowerCase() !==
                            (biz.ownerEmail || "").trim().toLowerCase();
                        const patch: Record<string, unknown> = {
                          name: editName.trim(),
                          brandVoice: editBrand,
                          preferredLanguage: editLanguage,
                        };
                        // Only send plan fields when the admin changed them —
                        // re-sending planCode rebuilds plan defaults/assignedAt.
                        if (editPlanCode !== (biz.plan?.code || "starter")) {
                          patch.planCode = editPlanCode;
                        }
                        if (editPlanStatus !== (biz.plan?.status || "active")) {
                          patch.planStatus = editPlanStatus;
                        }
                        // Only touch locations when the selection changed.
                        // Never send locationIds: [] on ordinary save (clears
                        // assignments unless confirmClearLocations is set).
                        if (editLocationId && editLocationId !== currentLocationId) {
                          patch.locationIds = [editLocationId];
                        }
                        if (ownerChanged) {
                          patch.ownerEmail = editOwnerEmail.trim();
                          if (editOwnerPassword) {
                            patch.ownerPassword = editOwnerPassword;
                          }
                        }
                        void patchBusiness(biz.id, patch);
                      }}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                    >
                      Save changes
                    </button>
                    {biz.ownerUserId && (
                      <button
                        type="button"
                        disabled={busy || editOwnerPassword.length < 8}
                        onClick={() =>
                          void resetOwnerPassword(
                            biz.ownerUserId as string,
                            editOwnerPassword
                          )
                        }
                        className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                        title="Explicit password reset — does not run when linking owners"
                      >
                        Reset owner password
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditingId(null)}
                      className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {deleteTarget && (
        <AdminPermanentDeleteDialog
          key={deleteTarget.id}
          businessId={deleteTarget.id}
          businessName={deleteTarget.name}
          open
          busy={busy}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(msg) => {
            setMessage(msg);
            setError(null);
            setDeleteTarget(null);
            void refreshLists();
          }}
          onError={(msg) => {
            setError(msg);
          }}
        />
      )}
    </div>
  );
}
