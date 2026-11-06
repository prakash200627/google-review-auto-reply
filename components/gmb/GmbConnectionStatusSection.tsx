import { GoogleConnectPanel } from "@/components/GoogleConnectPanel";
import {
  isAuthUser,
  listActiveBusinessIdsForUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import { userHasOrgAccess } from "@/lib/auth/googleRouteAuth";
import {
  getSafeGoogleConnectionStatus,
  GOOGLE_STATUS_LOAD_ERROR_MESSAGE,
  type SafeGoogleStatus,
} from "@/lib/google/connectionStatus";
import { isOAuthConfigured } from "@/lib/google/oauthConfig";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { readOrganizationId } from "@/lib/org/session";

/**
 * Async server segment: loads Google connection status (and BA workspace org
 * resolution) after the GMB shell has already streamed. Suspense boundary is
 * owned by app/gmb/page.tsx so intro + module nav are not blocked.
 *
 * allowConnect is derived only from server role — never from the client.
 */
export async function GmbConnectionStatusSection() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    return (
      <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Sign in required to view Google connection status.
      </p>
    );
  }

  const isSuperAdmin = auth.user.role === "superadmin";
  let initialStatus: SafeGoogleStatus;

  if (isSuperAdmin) {
    const orgId = await readOrganizationId();
    if (!orgId || !(await userHasOrgAccess(auth.user, orgId))) {
      initialStatus = {
        oauthConfigured: isOAuthConfigured(),
        connection: null,
        statusError:
          "Select a Google organization workspace under Businesses, then connect the platform Google account here.",
      };
    } else {
      try {
        initialStatus = await getSafeGoogleConnectionStatus(orgId);
      } catch {
        initialStatus = {
          oauthConfigured: isOAuthConfigured(),
          connection: null,
          statusError: GOOGLE_STATUS_LOAD_ERROR_MESSAGE,
        };
      }
    }
  } else {
    await connectToDatabase();
    const activeIds = await listActiveBusinessIdsForUser(auth.user);
    const business =
      activeIds.length > 0
        ? await Business.findById(activeIds[0]).select("orgId").lean()
        : null;
    const orgId = business ? String(business.orgId) : "";
    if (!orgId || !(await userHasOrgAccess(auth.user, orgId))) {
      initialStatus = {
        oauthConfigured: isOAuthConfigured(),
        connection: null,
        statusError:
          "No active business workspace is linked to your account. You can still use ORM with stored data. Ask a Super Admin for Google sync.",
      };
    } else {
      try {
        initialStatus = await getSafeGoogleConnectionStatus(orgId);
      } catch {
        initialStatus = {
          oauthConfigured: isOAuthConfigured(),
          connection: null,
          statusError: GOOGLE_STATUS_LOAD_ERROR_MESSAGE,
        };
      }
    }
  }

  return (
    <GoogleConnectPanel
      initialStatus={initialStatus}
      role={isSuperAdmin ? "superadmin" : "business_owner"}
      allowConnect={isSuperAdmin}
    />
  );
}
