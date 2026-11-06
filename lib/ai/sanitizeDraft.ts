/**
 * Strip accidental demo/test/sample/watermark suffixes from model output.
 * Prompts forbid these markers; this is defense-in-depth so they cannot
 * reach the publish UI or Google payload as trailing labels.
 *
 * Preserves mid-sentence wording such as "demo tasting menu".
 */

const FORBIDDEN_SUFFIX_PATTERNS: RegExp[] = [
  // DEMO — bare forms use \b so "ACADEMO" / similar words are preserved
  /\s*[-–—]\s*DEMO\s*$/i,
  /\s*\[DEMO\]\s*$/i,
  /\s*\(DEMO\)\s*$/i,
  /\s*#\s*DEMO\s*$/i,
  /\bDEMO\s*$/i,
  // TEST / TEST REPLY — \b avoids mangling words like "PROTEST"
  /\s*[-–—]\s*TEST(\s*REPLY)?\s*$/i,
  /\s*\[TEST(\s*REPLY)?\]\s*$/i,
  /\s*\(TEST(\s*REPLY)?\)\s*$/i,
  /\s*#\s*TEST(\s*REPLY)?\s*$/i,
  /\bTEST(\s*REPLY)?\s*$/i,
  // SAMPLE / WATERMARK (called out in the system prompt)
  /\s*[-–—]\s*SAMPLE(\s*REPLY)?\s*$/i,
  /\s*\[SAMPLE\]\s*$/i,
  /\s*\(SAMPLE\)\s*$/i,
  /\bSAMPLE(\s*REPLY)?\s*$/i,
  /\s*[-–—]\s*WATERMARK\s*$/i,
  /\s*\[WATERMARK\]\s*$/i,
  /\s*\(WATERMARK\)\s*$/i,
  /\bWATERMARK\s*$/i,
];

export function containsForbiddenDemoMarker(text: string): boolean {
  const value = String(text || "");
  return FORBIDDEN_SUFFIX_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Remove known demo/test/sample/watermark trailing markers.
 * Loops until stable so stacked suffixes ("… — DEMO — TEST") are cleared.
 */
export function sanitizeReplyDraft(text: string): string {
  let out = String(text || "").trim();
  let changed = true;
  let guard = 0;
  while (changed && guard < 20) {
    guard += 1;
    changed = false;
    for (const pattern of FORBIDDEN_SUFFIX_PATTERNS) {
      const next = out.replace(pattern, "").trim();
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    // Drop orphan trailing separators left after a strip (e.g. "Thanks —").
    const withoutSep = out.replace(/\s*[-–—]\s*$/g, "").trim();
    if (withoutSep !== out) {
      out = withoutSep;
      changed = true;
    }
  }
  out = out.replace(/[\s]+$/g, "").trim();
  return out;
}
