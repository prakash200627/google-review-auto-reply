/**
 * Canonical Google Business Profile location identity helpers.
 *
 * Stored uniqueness in Mongo is `{ orgId, googleLocationName }`.
 * The reviews API parent name `accounts/{accountId}/locations/{locationId}`
 * is the stable Google resource identity within an organization context.
 *
 * Display name, address, and placeId are never used as unique keys.
 * Missing googleLocationName must never produce keys like `orgId::undefined`.
 */

/** accounts/{accountId}/locations/{locationId} */
export const GOOGLE_LOCATION_NAME_RE =
  /^accounts\/([^/]+)\/locations\/([^/]+)$/;

export const ADMIN_LOCATION_LIST_LIMITS = {
  defaultLimit: 80,
  maxLimit: 120,
  /** Max rows scanned from Mongo before in-memory filter/dedupe. */
  maxScan: 500,
} as const;

export type LocationIdentityFields = {
  orgId?: unknown;
  googleLocationName?: unknown;
  _id?: unknown;
  id?: unknown;
  businessId?: unknown;
  updatedAt?: unknown;
  title?: unknown;
  address?: unknown;
};

export function normalizeGoogleLocationName(
  value: unknown
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!GOOGLE_LOCATION_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

export function normalizeOrgId(value: unknown): string | null {
  if (value == null) return null;
  const id = String(value).trim();
  if (!id || id === "undefined" || id === "null") return null;
  return id;
}

/**
 * Canonical selector identity: orgId + validated googleLocationName.
 * Returns null when either part is missing/invalid — callers must exclude.
 */
export function buildLocationIdentityKey(
  orgId: unknown,
  googleLocationName: unknown
): string | null {
  const org = normalizeOrgId(orgId);
  const name = normalizeGoogleLocationName(googleLocationName);
  if (!org || !name) return null;
  return `${org}::${name}`;
}

/** Stable React list key for a location row that already has a valid identity. */
export function locationListKey(
  identityKey: string | null | undefined,
  documentId: unknown
): string | null {
  if (identityKey && !identityKey.includes("undefined")) {
    return identityKey;
  }
  const id = documentId != null ? String(documentId).trim() : "";
  if (id && id !== "undefined" && id !== "null") {
    return `doc:${id}`;
  }
  return null;
}

export function isValidEnrollableLocation(loc: LocationIdentityFields): boolean {
  return buildLocationIdentityKey(loc.orgId, loc.googleLocationName) != null;
}

/**
 * Prefer assigned document when merging duplicates; otherwise newest updatedAt.
 */
export function preferLocationDocument<T extends LocationIdentityFields>(
  a: T,
  b: T
): T {
  const aAssigned = Boolean(a.businessId);
  const bAssigned = Boolean(b.businessId);
  if (bAssigned && !aAssigned) return b;
  if (aAssigned && !bAssigned) return a;
  const aTime = new Date(String(a.updatedAt || 0)).getTime();
  const bTime = new Date(String(b.updatedAt || 0)).getTime();
  return bTime > aTime ? b : a;
}

/**
 * Deduplicate by canonical identity. Rows without a valid identity are skipped
 * (counted in skippedInvalid). Same display names with different resource IDs
 * remain separate.
 */
export function dedupeLocationsByIdentity<T extends LocationIdentityFields>(
  rows: T[]
): { unique: T[]; skippedInvalid: number; duplicateCollapsed: number } {
  const byKey = new Map<string, T>();
  let skippedInvalid = 0;
  let duplicateCollapsed = 0;

  for (const row of rows) {
    const key = buildLocationIdentityKey(row.orgId, row.googleLocationName);
    if (!key) {
      skippedInvalid += 1;
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    duplicateCollapsed += 1;
    byKey.set(key, preferLocationDocument(existing, row));
  }

  return {
    unique: [...byKey.values()],
    skippedInvalid,
    duplicateCollapsed,
  };
}

export function clampAdminLocationLimit(raw: unknown): number {
  const fallback = ADMIN_LOCATION_LIST_LIMITS.defaultLimit;
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  // Treat non-numeric / non-positive as default (Number(null) is 0).
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(ADMIN_LOCATION_LIST_LIMITS.maxLimit, Math.floor(n));
}

export function clampAdminLocationOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function paginateSlice<T>(
  items: T[],
  offset: number,
  limit: number
): { page: T[]; hasMore: boolean; totalMatched: number } {
  const totalMatched = items.length;
  const page = items.slice(offset, offset + limit);
  return {
    page,
    hasMore: offset + page.length < totalMatched,
    totalMatched,
  };
}
