import { NextResponse } from "next/server";

export type JsonObject = Record<string, unknown>;

/**
 * Read a JSON object body for mutating routes.
 * - Empty / whitespace-only body → `{}` (safe PATCH no-op / optional body).
 * - Malformed JSON → 400 with code invalid_json (never throws).
 * - Non-object JSON (array/string/number/null) → 400.
 * Does not log raw bodies.
 */
export async function readJsonObjectBody(
  request: Request
): Promise<{ ok: true; body: JsonObject } | { ok: false; response: NextResponse }> {
  let text = "";
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "invalid_body",
          message: "Could not read request body.",
        },
        { status: 400 }
      ),
    };
  }

  if (!text.trim()) {
    return { ok: true, body: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "invalid_json",
          message: "Invalid JSON body.",
        },
        { status: 400 }
      ),
    };
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "invalid_json",
          message: "JSON body must be an object.",
        },
        { status: 400 }
      ),
    };
  }

  return { ok: true, body: parsed as JsonObject };
}
