import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { startAuthorization } from "@/lib/google/oauth";
import {
  GoogleOAuthError,
  isOAuthConfigured,
} from "@/lib/google/oauthConfig";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { ensureOrganizationSession } from "@/lib/org/session";

export const runtime = "nodejs";

/**
 * Start Google OAuth for the platform GBP connection.
 * Super Admin only — Business Admins use TRONX email/password login and
 * do not connect personal Google accounts. Google OAuth is never used as
 * TRONX app authentication.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  try {
    if (!isOAuthConfigured()) {
      return NextResponse.json(
        {
          success: false,
          message: "Google OAuth is not configured on the server",
          code: "not_configured",
        },
        { status: 503 }
      );
    }

    const auth = await requireAuthUser();
    if (!isAuthUser(auth)) return auth.response;
    const actor = { actorId: auth.user.userId, actorRole: auth.user.role };

    if (auth.user.role !== "superadmin") {
      auditLog({
        ...actor,
        action: "google.oauth_start",
        success: false,
        code: "superadmin_required",
      });
      return NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message:
            "Only Super Admin can connect the TRONX Google Business Profile account. Sign in with your TRONX email/password; ask a Super Admin if Google sync is unavailable.",
        },
        { status: 403 }
      );
    }

    let returnPath: unknown = "/gmb";
    try {
      const body = (await request.json()) as {
        returnPath?: unknown;
        orgId?: unknown;
        businessId?: unknown;
      };
      if (body && "orgId" in body && body.orgId != null && body.orgId !== "") {
        auditLog({
          ...actor,
          action: "google.oauth_start",
          success: false,
          code: "org_id_not_allowed",
        });
        return NextResponse.json(
          {
            success: false,
            code: "forbidden",
            message:
              "orgId cannot be set on OAuth start. Super Admins select an organization via /api/admin/organizations/select first.",
          },
          { status: 403 }
        );
      }
      if (body && "returnPath" in body) {
        returnPath = body.returnPath;
      }
      // Ignore businessId — platform connection is org-scoped, not owner OAuth.
      void body?.businessId;
    } catch {
      // empty body is fine
    }

    const orgId = await ensureOrganizationSession();
    const started = await startAuthorization({
      orgId,
      initiatedByUserId: auth.user.userId,
      connectionSource: "platform",
      businessId: null,
      returnPath,
    });

    auditLog({
      ...actor,
      action: "google.oauth_start",
      success: true,
      target: { orgId, connectionSource: "platform" },
    });

    return NextResponse.json({
      success: true,
      authUrl: started.authUrl,
      expiresAt: started.expiresAt.toISOString(),
      connectionSource: "platform",
    });
  } catch (err) {
    if (err instanceof GoogleOAuthError) {
      return NextResponse.json(
        { success: false, message: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error(
      "OAuth start failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      { success: false, message: "Failed to start Google authorization" },
      { status: 500 }
    );
  }
}
