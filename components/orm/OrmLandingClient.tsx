"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { SearchableSelect } from "@/components/reviews/SearchableSelect";

export function OrmLandingClient({
  businesses,
  groups,
  isSuperAdmin,
  singleBusinessId,
  needsOrgSelection = false,
  orgId = null,
}: {
  businesses: Array<{ id: string; name: string; groupId: string | null }>;
  groups: Array<{ id: string; name: string; businessCount: number }>;
  isSuperAdmin: boolean;
  singleBusinessId: string | null;
  needsOrgSelection?: boolean;
  orgId?: string | null;
}) {
  const router = useRouter();
  const [businessId, setBusinessId] = useState(singleBusinessId || "");
  const [groupId, setGroupId] = useState("");

  const businessOptions = useMemo(
    () =>
      businesses.map((b) => ({
        id: String(b.id),
        label: b.name || "Business",
      })),
    [businesses]
  );
  const groupOptions = useMemo(
    () =>
      groups.map((g) => ({
        id: String(g.id),
        label: `${g.name} (${g.businessCount} business${
          g.businessCount === 1 ? "" : "es"
        })`,
      })),
    [groups]
  );

  function openBusiness(id: string) {
    setBusinessId(id);
    if (id) router.push(`/orm/business/${encodeURIComponent(id)}`);
  }

  function openGroup(id: string) {
    setGroupId(id);
    if (id) router.push(`/orm/group/${encodeURIComponent(id)}`);
  }

  if (needsOrgSelection && isSuperAdmin) {
    return (
      <section className="rounded-md border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
        <p className="font-medium">Select an organization first</p>
        <p className="mt-2">
          Super Admin ORM selectors are scoped to the active organization
          session. Choose an organization under{" "}
          <Link className="underline" href="/admin/businesses">
            Admin → Businesses
          </Link>{" "}
          (organization switcher) or connect/select one under{" "}
          <Link className="underline" href="/gmb">
            GMB
          </Link>
          , then return here.
        </p>
      </section>
    );
  }

  if (!isSuperAdmin && businesses.length === 0 && groups.length === 0) {
    return (
      <section className="rounded-md border border-dashed border-zinc-300 bg-white p-5 text-sm text-zinc-600">
        <p className="font-medium text-zinc-800">No workspace assigned</p>
        <p className="mt-2">
          Ask a Super Admin to assign a business or group to your account.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {isSuperAdmin && orgId && (
        <p className="text-xs text-zinc-500">
          Showing businesses and groups for the active organization only.
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">
          Business dashboard
        </h2>
        <p className="text-sm text-zinc-600">
          Open metrics and recent reviews for one authorized business.
        </p>

        {businesses.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-600">
            {isSuperAdmin
              ? "No businesses in the active organization. Create or move businesses under Admin → Businesses."
              : "No businesses are assigned to your account."}
          </p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-2 text-sm">
              {businesses.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/orm/business/${encodeURIComponent(b.id)}`}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 hover:bg-zinc-50"
                  >
                    {b.name}
                  </Link>
                </li>
              ))}
            </ul>
            {businesses.length > 5 && (
              <div className="max-w-md">
                <SearchableSelect
                  label="Business"
                  value={businessId}
                  options={businessOptions}
                  onChange={openBusiness}
                  emptyLabel="Select a business…"
                  placeholder="Search businesses…"
                />
              </div>
            )}
            {singleBusinessId && businesses.length === 1 && (
              <p className="text-xs text-zinc-500">
                You have one assigned business —{" "}
                <Link
                  className="underline"
                  href={`/orm/business/${encodeURIComponent(singleBusinessId)}`}
                >
                  open its dashboard
                </Link>
                .
              </p>
            )}
          </>
        )}
      </section>

      {(isSuperAdmin || groups.length > 0) && (
        <section className="space-y-3 border-t border-zinc-200 pt-6">
          <h2 className="text-sm font-semibold text-zinc-900">
            Group dashboard
          </h2>
          <p className="text-sm text-zinc-600">
            Aggregate metrics across member businesses that belong to the group
            and that you are authorized to access. Membership comes only from
            stored Business.groupId links.
          </p>

          {groups.length === 0 ? (
            <p className="rounded-md border border-dashed border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-600">
              {isSuperAdmin
                ? "No groups exist in the active organization. Create groups under Admin → Groups. Existing businesses are not assigned automatically."
                : "No groups are assigned to your account."}
            </p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-2 text-sm">
                {groups.map((g) => (
                  <li key={g.id}>
                    <Link
                      href={`/orm/group/${encodeURIComponent(g.id)}`}
                      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 hover:bg-zinc-50"
                    >
                      {g.name}
                      <span className="ml-1 text-zinc-500">
                        ({g.businessCount})
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {groups.length > 5 && (
                <div className="max-w-md">
                  <SearchableSelect
                    label="Group"
                    value={groupId}
                    options={groupOptions}
                    onChange={openGroup}
                    emptyLabel="Select a group…"
                    placeholder="Search groups…"
                  />
                </div>
              )}
            </>
          )}
        </section>
      )}

      <p className="text-sm text-zinc-600">
        Day-to-day reply work stays in{" "}
        <Link className="underline" href="/orm/reviews">
          Reviews
        </Link>
        . Google sync stays under GMB.
      </p>
    </div>
  );
}
