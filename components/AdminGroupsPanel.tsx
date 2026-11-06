"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type GroupRow = {
  id: string;
  name: string;
  description: string;
  orgId: string;
  active: boolean;
  businessCount: number;
  adminCount: number;
  businesses: { id: string; name: string; active: boolean }[];
  admins: { id: string; email: string; name: string; active: boolean }[];
};

type BusinessOption = { id: string; name: string; groupId?: string | null };
type OwnerOption = { id: string; email: string; name: string };

export function AdminGroupsPanel() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [assignBusinessId, setAssignBusinessId] = useState("");
  const [assignAdminId, setAssignAdminId] = useState("");
  const loadInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const [gRes, bRes, oRes] = await Promise.all([
        fetch("/api/admin/groups"),
        fetch("/api/admin/businesses"),
        fetch("/api/admin/owners"),
      ]);
      const gData = (await gRes.json()) as {
        success?: boolean;
        groups?: GroupRow[];
        message?: string;
      };
      const bData = (await bRes.json()) as {
        success?: boolean;
        businesses?: BusinessOption[];
      };
      const oData = (await oRes.json()) as {
        success?: boolean;
        owners?: OwnerOption[];
      };
      if (!gRes.ok || !gData.success) {
        setError(gData.message || "Could not load groups");
        setLoaded(false);
        return;
      }
      setGroups(gData.groups || []);
      setBusinesses(bData.businesses || []);
      setOwners(oData.owners || []);
      setLoaded(true);
    } catch {
      setError("Could not load groups");
      setLoaded(false);
    } finally {
      setLoading(false);
      loadInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    // React Strict Mode remounts: do not gate on loadInFlightRef here or the
    // second mount can exit early and leave loading=true forever.
    let cancelled = false;

    void (async () => {
      try {
        const [gRes, bRes, oRes] = await Promise.all([
          fetch("/api/admin/groups"),
          fetch("/api/admin/businesses"),
          fetch("/api/admin/owners"),
        ]);
        if (cancelled) return;
        const gData = (await gRes.json()) as {
          success?: boolean;
          groups?: GroupRow[];
          message?: string;
        };
        const bData = (await bRes.json()) as {
          success?: boolean;
          businesses?: BusinessOption[];
        };
        const oData = (await oRes.json()) as {
          success?: boolean;
          owners?: OwnerOption[];
        };
        if (cancelled) return;
        if (!gRes.ok || !gData.success) {
          setError(gData.message || "Could not load groups");
          setLoaded(false);
          return;
        }
        setGroups(gData.groups || []);
        setBusinesses(bData.businesses || []);
        setOwners(oData.owners || []);
        setLoaded(true);
      } catch {
        if (!cancelled) {
          setError("Could not load groups");
          setLoaded(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function createGroup() {
    setError(null);
    setInfo(null);
    const res = await fetch("/api/admin/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    const data = (await res.json()) as { success?: boolean; message?: string };
    if (!res.ok || !data.success) {
      setError(data.message || "Create failed");
      return;
    }
    setName("");
    setDescription("");
    setInfo("Group created.");
    await load();
  }

  async function assignBusiness() {
    if (!selectedGroupId || !assignBusinessId) return;
    setError(null);
    setInfo(null);
    const res = await fetch(
      `/api/admin/businesses/${encodeURIComponent(assignBusinessId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: selectedGroupId }),
      }
    );
    const data = (await res.json()) as { success?: boolean; message?: string };
    if (!res.ok || !data.success) {
      setError(data.message || "Assign business failed");
      return;
    }
    setInfo("Business assigned to group.");
    setAssignBusinessId("");
    await load();
  }

  async function assignAdmin() {
    if (!selectedGroupId || !assignAdminId) return;
    setError(null);
    setInfo(null);
    const res = await fetch(
      `/api/admin/groups/${encodeURIComponent(selectedGroupId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addAdminUserId: assignAdminId }),
      }
    );
    const data = (await res.json()) as { success?: boolean; message?: string };
    if (!res.ok || !data.success) {
      setError(data.message || "Assign admin failed");
      return;
    }
    setInfo("Business Admin assigned to group.");
    setAssignAdminId("");
    await load();
  }

  async function deleteGroup(groupId: string) {
    if (
      !window.confirm(
        "Delete this empty group? Businesses must be ungrouped first. Google data is never deleted."
      )
    ) {
      return;
    }
    setError(null);
    setInfo(null);
    const res = await fetch(`/api/admin/groups/${encodeURIComponent(groupId)}`, {
      method: "DELETE",
    });
    const data = (await res.json()) as { success?: boolean; message?: string };
    if (!res.ok || !data.success) {
      setError(data.message || "Delete failed");
      return;
    }
    setInfo("Group deleted.");
    if (selectedGroupId === groupId) setSelectedGroupId("");
    await load();
  }

  return (
    <div className="space-y-6">
      <div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm"
        >
          {loaded ? "Refresh groups" : "Load groups"}
        </button>
      </div>
      <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">Create group</h2>
        <p className="text-xs text-zinc-600">
          Groups organize internal businesses for Business Admins. They are not
          Google entities and never auto-claim locations.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name"
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void createGroup()}
            disabled={!name.trim()}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">
          Assign business / Business Admin
        </h2>
        <select
          value={selectedGroupId}
          onChange={(e) => setSelectedGroupId(e.target.value)}
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="">Select group…</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.businessCount} businesses)
            </option>
          ))}
        </select>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={assignBusinessId}
            onChange={(e) => setAssignBusinessId(e.target.value)}
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="">Select business…</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.groupId ? " (grouped)" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void assignBusiness()}
            disabled={!selectedGroupId || !assignBusinessId}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
          >
            Assign business
          </button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={assignAdminId}
            onChange={(e) => setAssignAdminId(e.target.value)}
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="">Select Business Admin…</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.email}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void assignAdmin()}
            disabled={!selectedGroupId || !assignAdminId}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
          >
            Assign admin
          </button>
        </div>
      </section>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {info && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {info}
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">Groups</h2>
        {loading && (
          <p className="text-sm text-zinc-500" role="status">
            Loading groups…
          </p>
        )}
        {!loading && error && !loaded && (
          <p className="text-sm text-red-700" role="alert">
            Could not load groups. Use Refresh to retry.
          </p>
        )}
        {!loading && loaded && groups.length === 0 && (
          <p className="text-sm text-zinc-500">No groups yet.</p>
        )}
        <ul className="space-y-3">
          {groups.map((g) => (
            <li
              key={g.id}
              className="rounded-lg border border-zinc-200 bg-white p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-zinc-900">{g.name}</p>
                  <p className="text-xs text-zinc-500">
                    {g.description || "No description"} ·{" "}
                    {g.active ? "active" : "inactive"}
                  </p>
                  <p className="mt-1 text-xs text-zinc-600">
                    {g.businessCount} business(es) · {g.adminCount} admin(s)
                  </p>
                  {g.businesses.length > 0 && (
                    <p className="mt-1 text-xs text-zinc-600">
                      Businesses:{" "}
                      {g.businesses.map((b) => b.name).join(", ")}
                    </p>
                  )}
                  {g.admins.length > 0 && (
                    <p className="mt-1 text-xs text-zinc-600">
                      Admins: {g.admins.map((a) => a.email).join(", ")}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void deleteGroup(g.id)}
                  className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-800"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
