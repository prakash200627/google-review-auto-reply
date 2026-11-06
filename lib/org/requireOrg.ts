import { NextResponse } from "next/server";
import { readOrganizationId } from "@/lib/org/session";

/**
 * Require a provisional org session for Route Handlers.
 * Uses only a server-signed cookie whose org still exists — never adopts
 * another org's connection and never trusts a bare client ObjectId.
 * Alone this is NOT sufficient for protected business operations
 * (those also require a signed-in user + role/membership checks).
 */
export async function requireOrganizationId(): Promise<
  { orgId: string } | { response: NextResponse }
> {
  const orgId = await readOrganizationId();
  if (!orgId) {
    return {
      response: NextResponse.json(
        {
          success: false,
          code: "no_session",
          message:
            "No organization session. Connect Google under GMB → Connection (Super Admin) first.",
        },
        { status: 401 }
      ),
    };
  }
  return { orgId };
}

export function isOrgResult(
  value: { orgId: string } | { response: NextResponse }
): value is { orgId: string } {
  return "orgId" in value;
}
