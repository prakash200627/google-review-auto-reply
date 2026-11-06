/**
 * Safely classify MONGODB_URI without printing credentials or the full URI.
 * Exit 0 always; prints JSON with positivelyNonProduction boolean.
 */
import fs from "node:fs";
import path from "node:path";

function loadUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return null;
  const text = fs.readFileSync(envPath, "utf8");
  const match = text.match(/^MONGODB_URI\s*=\s*(.+)$/m);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function hostHint(uri) {
  try {
    const normalized = uri
      .replace(/^mongodb(\+srv)?:\/\//i, "http://")
      .replace(/:[^/@]+@/, "@");
    return new URL(normalized).hostname || "";
  } catch {
    return "";
  }
}

const uri = loadUri();
if (!uri) {
  console.log(
    JSON.stringify({
      exists: false,
      positivelyNonProduction: false,
      recommendation: "do-not-run-missing-uri",
    })
  );
  process.exit(0);
}

const host = hostHint(uri);
const hay = `${host} ${uri.split("@").pop() || ""}`.toLowerCase();
const signals = {
  loopback: /localhost|127\.0\.0\.1/.test(hay),
  atlasLike: /mongodb\.net/.test(hay),
  nameHasProd: /\bprod(uction)?\b/.test(hay),
  nameHasNonProd: /\b(dev|test|local|staging|sandbox)\b/.test(hay),
};

const positivelyNonProduction =
  signals.loopback || (signals.nameHasNonProd && !signals.nameHasProd);
const looksProductionLike = signals.nameHasProd && !signals.loopback;

console.log(
  JSON.stringify({
    exists: true,
    hostClass: signals.loopback
      ? "loopback"
      : signals.atlasLike
        ? "atlas-like"
        : "other",
    signals,
    positivelyNonProduction,
    looksProductionLike,
    recommendation: positivelyNonProduction
      ? "may-run-dry-run-only"
      : looksProductionLike
        ? "do-not-run"
        : "do-not-run-uncertain",
  })
);
