import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import {
  classifyCallbackQuery,
  completeAuthorization,
} from "@/lib/google/oauth";
import { appBaseUrl, GoogleOAuthError } from "@/lib/google/oauthConfig";
import { applyOrganizationCookie } from "@/lib/org/session";

export const runtime = "nodejs";

/**
 * Google OAuth callback (browser redirect from Google).
 * No Origin check — Google is the redirector. Cookie binding uses only the
 * orgId stored in single-use OAuth state.
 */

function redirectWithStatus(
  path: string,
  params: Record<string, string>
): NextResponse {
  const url = new URL(path, appBaseUrl());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = {
    error: searchParams.get("error") || undefined,
    code: searchParams.get("code") || undefined,
    state: searchParams.get("state") || undefined,
  };

  const classified = classifyCallbackQuery(query);
  if (!classified.ok) {
    auditLog({
      actorId: null,
      actorRole: null,
      action: "google.oauth_callback",
      success: false,
      code: classified.reason,
    });
    return redirectWithStatus("/gmb", {
      google: "error",
      reason: classified.reason,
    });
  }

  try {
    const result = await completeAuthorization({
      code: query.code,
      state: query.state,
    });
    // Prefer /gmb for legacy return paths so bookmarks stay consistent.
    const safeReturn =
      !result.returnPath ||
      result.returnPath === "/settings/google" ||
      result.returnPath === "/dashboard"
        ? "/gmb"
        : result.returnPath;
    const response = redirectWithStatus(safeReturn, {
      google: "connected",
    });
    // Bind provisional org session on the redirect so status/page reads work.
    applyOrganizationCookie(response, result.orgId);
    auditLog({
      actorId: null,
      actorRole: null,
      action: "google.oauth_callback",
      success: true,
      target: { orgId: result.orgId },
    });
    return response;
  } catch (err) {
    const reason =
      err instanceof GoogleOAuthError ? err.code : "callback_failed";
    auditLog({
      actorId: null,
      actorRole: null,
      action: "google.oauth_callback",
      success: false,
      code: reason,
    });
    console.error(
      "OAuth callback failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return redirectWithStatus("/gmb", {
      google: "error",
      reason,
    });
  }
}
