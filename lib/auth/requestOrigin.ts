import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/google/oauthConfig";

/**
 * Browser CSRF defense-in-depth for cookie-authenticated mutations.
 *
 * SameSite=Lax session cookies already block most cross-site POSTs. When a
 * browser sends `Origin` (or `Referer`), it must match this app's origin.
 *
 * Exceptions / allowances:
 * - GET/HEAD/OPTIONS are not checked (safe methods).
 * - OAuth callback is GET from Google — do not apply this helper there.
 * - Requests with neither Origin nor Referer are allowed so non-browser
 *   clients (curl, server jobs) keep working. Document that those clients
 *   must protect credentials separately.
 */

function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function allowedAppOrigins(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  const allowed = new Set<string>();
  const configured = normalizeOrigin(appBaseUrl(env));
  if (configured) allowed.add(configured);

  try {
    const reqUrl = new URL(request.url);
    allowed.add(`${reqUrl.protocol}//${reqUrl.host}`);
  } catch {
    // ignore
  }

  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto") ||
    (env.NODE_ENV === "production" ? "https" : "http");
  if (host) {
    const fromHost = normalizeOrigin(`${proto}://${host.split(",")[0]!.trim()}`);
    if (fromHost) allowed.add(fromHost);
  }

  return allowed;
}

export function mutationOriginAllowed(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }

  const allowed = allowedAppOrigins(request, env);
  const originHeader = request.headers.get("origin");
  if (originHeader) {
    const origin = normalizeOrigin(originHeader);
    return Boolean(origin && allowed.has(origin));
  }

  const referer = request.headers.get("referer");
  if (referer) {
    const origin = normalizeOrigin(referer);
    return Boolean(origin && allowed.has(origin));
  }

  // No Origin/Referer — treat as non-browser client.
  return true;
}

export function assertMutationOrigin(
  request: Request
): { ok: true } | { ok: false; response: NextResponse } {
  if (mutationOriginAllowed(request)) {
    return { ok: true };
  }
  return {
    ok: false,
    response: NextResponse.json(
      {
        success: false,
        code: "csrf_origin",
        message: "Request origin is not allowed for this action.",
      },
      { status: 403 }
    ),
  };
}
