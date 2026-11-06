/**
 * Safe Google Business Profile / My Business API error.
 * Never attach raw response bodies, tokens, or secrets.
 */

export type GoogleFieldViolation = {
  field: string;
  description: string;
};

export class GoogleBusinessApiError extends Error {
  code: string;
  status: number;
  googleStatus: string;
  fieldViolations: GoogleFieldViolation[];

  constructor(
    message: string,
    {
      code = "gbp_api_error",
      status = 502,
      googleStatus = "",
      fieldViolations = [],
    }: {
      code?: string;
      status?: number;
      googleStatus?: string;
      fieldViolations?: GoogleFieldViolation[];
    } = {}
  ) {
    super(message);
    this.name = "GoogleBusinessApiError";
    this.code = code;
    this.status = status;
    this.googleStatus = googleStatus;
    this.fieldViolations = fieldViolations;
  }
}

const MAX_VIOLATIONS = 8;
const MAX_DESC_LEN = 200;
const MAX_FIELD_LEN = 120;

/** Extract BadRequest fieldViolations without leaking tokens or large payloads. */
export function extractGoogleFieldViolations(
  body: unknown
): GoogleFieldViolation[] {
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as {
          error?: {
            details?: unknown;
          };
        }).error
      : undefined;
  const details = Array.isArray(err?.details) ? err.details : [];
  const out: GoogleFieldViolation[] = [];

  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const type = String((detail as { "@type"?: string })["@type"] || "");
    if (
      type &&
      !/BadRequest|badRequest/i.test(type) &&
      !("fieldViolations" in detail)
    ) {
      continue;
    }
    const violations = (detail as { fieldViolations?: unknown }).fieldViolations;
    if (!Array.isArray(violations)) continue;
    for (const v of violations) {
      if (!v || typeof v !== "object") continue;
      const field = String((v as { field?: unknown }).field || "")
        .trim()
        .slice(0, MAX_FIELD_LEN);
      const description = String(
        (v as { description?: unknown }).description || ""
      )
        .trim()
        .slice(0, MAX_DESC_LEN);
      if (!field && !description) continue;
      // Never surface credential-looking strings.
      if (/token|bearer|authorization|password|secret/i.test(description)) {
        continue;
      }
      out.push({
        field: field || "(unknown)",
        description: description || "Invalid value",
      });
      if (out.length >= MAX_VIOLATIONS) return out;
    }
  }
  return out;
}

/** Map HTTP / Google status to a user-safe message (no secrets). */
export function safeGoogleApiMessage(input: {
  httpStatus: number;
  googleStatus?: string;
  googleMessage?: string;
  fieldViolations?: GoogleFieldViolation[];
}): string {
  const status = (input.googleStatus || "").toUpperCase();
  if (input.httpStatus === 401 || status === "UNAUTHENTICATED") {
    return "Google rejected the access token. Reconnect Google under Settings.";
  }
  if (input.httpStatus === 403 || status === "PERMISSION_DENIED") {
    return "Google denied access to this Business Profile resource. Check account permissions and that required APIs are enabled.";
  }
  if (
    status === "PERMISSION_DENIED" ||
    /SERVICE_DISABLED|API has not been used/i.test(input.googleMessage || "")
  ) {
    return "A required Google Business Profile API is disabled or unavailable for this Cloud project.";
  }
  if (input.httpStatus === 404 || status === "NOT_FOUND") {
    return "Google could not find that Business Profile account or location.";
  }
  if (input.httpStatus === 409 || status === "ALREADY_EXISTS") {
    return "A conflicting Google Business Profile location already exists for this account.";
  }
  if (input.httpStatus === 400 || status === "INVALID_ARGUMENT") {
    const violations = input.fieldViolations || [];
    if (violations.length > 0) {
      const summary = violations
        .map((v) => `${v.field}: ${v.description}`)
        .join("; ");
      return `Google rejected the location data (${summary}).`;
    }
    const gm = String(input.googleMessage || "").trim().slice(0, 240);
    if (
      gm &&
      !/token|bearer|authorization|password|secret|ya29\.|AIza/i.test(gm)
    ) {
      return `Google rejected the location data: ${gm}`;
    }
    return "Google rejected the location data. Check title, language, category (gcid:…), region code, and street address — city must not be copied into state or address lines.";
  }
  if (input.httpStatus === 429 || status === "RESOURCE_EXHAUSTED") {
    return "Google API rate limit exceeded. Try again shortly.";
  }
  if (input.httpStatus >= 500) {
    return "Google Business Profile API is temporarily unavailable.";
  }
  return "Google Business Profile API request failed.";
}

export function classifyGoogleApiErrorBody(
  httpStatus: number,
  body: unknown
): GoogleBusinessApiError {
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as {
          error?: { status?: string; message?: string; code?: number };
        }).error
      : undefined;
  const googleStatus = typeof err?.status === "string" ? err.status : "";
  const googleMessage = typeof err?.message === "string" ? err.message : "";
  const fieldViolations = extractGoogleFieldViolations(body);
  const message = safeGoogleApiMessage({
    httpStatus,
    googleStatus,
    googleMessage,
    fieldViolations,
  });

  let code = "gbp_api_error";
  if (httpStatus === 401 || googleStatus === "UNAUTHENTICATED") {
    code = "unauthenticated";
  } else if (httpStatus === 403 || googleStatus === "PERMISSION_DENIED") {
    code = /SERVICE_DISABLED|API has not been used/i.test(googleMessage)
      ? "api_disabled"
      : "permission_denied";
  } else if (httpStatus === 404 || googleStatus === "NOT_FOUND") {
    code = "not_found";
  } else if (httpStatus === 409 || googleStatus === "ALREADY_EXISTS") {
    code = "already_exists";
  } else if (httpStatus === 400 || googleStatus === "INVALID_ARGUMENT") {
    code = "invalid_argument";
  } else if (httpStatus === 429) {
    code = "rate_limited";
  }

  if (fieldViolations.length > 0) {
    console.error(
      "Google Business API field violations:",
      JSON.stringify({
        httpStatus,
        googleStatus,
        fields: fieldViolations.map((v) => v.field),
      })
    );
  }

  return new GoogleBusinessApiError(message, {
    code,
    status: httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
    googleStatus,
    fieldViolations,
  });
}
