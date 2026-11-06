/**
 * Read-only env classification — never prints secrets or full URIs.
 */
import { readFileSync, existsSync } from "fs";
import { pathToFileURL } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) return { present: false, keys: [], uri: "" };
  const text = readFileSync(".env.local", "utf8");
  const keys = [];
  let uri = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    keys.push(key);
    if (key === "MONGODB_URI") {
      while (value.startsWith("MONGODB_URI=")) {
        value = value.slice("MONGODB_URI=".length);
      }
      uri = value;
    }
  }
  return { present: true, keys, uri };
}

function hostSuffix(host) {
  if (!host) return null;
  const parts = String(host).split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

async function main() {
  const env = loadDotEnvLocal();
  if (!env.present) {
    console.log(JSON.stringify({ env_local: "missing", secrets_printed: false }));
    process.exit(1);
  }

  // Prefer compiled/runtime helpers via dynamic import of the TS module through next's path —
  // fall back to inline classification matching lib/mongodb.ts rules.
  let kind = "unknown";
  let scheme = null;
  let host = null;
  let guard = "ok";

  try {
    const raw = env.uri || "";
    const m = raw.match(/^(mongodb(?:\+srv)?):\/\/([^/?]+)/i);
    scheme = m ? m[1].toLowerCase() : null;
    const authority = m ? m[2] : "";
    host = authority.includes("@") ? authority.split("@").pop() : authority;
    host = host ? host.split(":")[0] : null;
    const h = (host || "").toLowerCase();
    if (!scheme) kind = "invalid";
    else if (h === "localhost" || h === "127.0.0.1" || h === "::1") kind = "local";
    else if (h.endsWith(".mongodb.net")) kind = "atlas";
    else kind = "remote_other";

    // Mirror assertDevelopmentMongoUri: atlas/local ok; remote_other needs ALLOW_REMOTE_MONGO
    if (kind === "remote_other" && process.env.ALLOW_REMOTE_MONGO !== "1") {
      guard = "blocked_remote_other";
    } else if (kind === "invalid" || !env.uri) {
      guard = "missing_or_invalid_uri";
    }
  } catch (e) {
    guard = e instanceof Error ? e.message.slice(0, 80) : "classify_failed";
  }

  const interesting = [
    "MONGODB_URI",
    "AUTH_SECRET",
    "APP_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "GOOGLE_TOKEN_ENCRYPTION_KEY",
    "OPENAI_API_KEY",
    "AUTO_PUBLISH_GLOBALLY_ENABLED",
    "AUTO_PUBLISH_SCHEDULER_SECRET",
    "SUPERADMIN_EMAIL",
  ];

  console.log(
    JSON.stringify({
      env_local: "present",
      key_count: env.keys.length,
      has_MONGODB_URI: env.keys.includes("MONGODB_URI"),
      uri_scheme: scheme,
      uri_host_suffix: hostSuffix(host),
      classification: kind,
      guard,
      configured_flags: Object.fromEntries(
        interesting.map((k) => [k, env.keys.includes(k)])
      ),
      secrets_printed: false,
    })
  );
}

main();
