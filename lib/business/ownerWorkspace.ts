import {
  assertBusinessAccess,
  listActiveBusinessIdsForUser,
  type AuthUser,
} from "@/lib/auth/authorize";

/** Resolve the owner's primary active business id for workspace pages. */
export async function resolveOwnerBusinessId(
  user: AuthUser,
  requestedBusinessId?: string | null
): Promise<string | null> {
  if (requestedBusinessId) {
    const access = await assertBusinessAccess(user, requestedBusinessId);
    if (access.ok) return String(access.business._id);
    return null;
  }
  const ids = await listActiveBusinessIdsForUser(user);
  return ids[0] || null;
}
