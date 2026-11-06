/**
 * Report whether MONGODB_URI is set and approved for Atlas — never prints the URI.
 * Usage: node scripts/check-mongo-configured.mjs [.env.local]
 */
import fs from "fs";

const path = process.argv[2] || ".env.local";
if (!fs.existsSync(path)) {
  console.log("file=missing");
  console.log("configured=false");
  console.log("verdict=empty");
  process.exit(0);
}

const text = fs.readFileSync(path, "utf8");
const m = text.match(/^MONGODB_URI=(.*)$/m);
const raw = (m ? m[1] : "").trim().replace(/^['"]|['"]$/g, "");

if (!raw || raw.includes("<") || raw.includes("REPLACE_WITH")) {
  console.log("file=present");
  console.log("configured=false");
  console.log("verdict=empty");
  process.exit(0);
}

try {
  const normalized = raw.replace(/^mongodb\+srv/, "mongodb");
  const u = new URL(normalized);
  const host = u.hostname;
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  const isAtlas = /\.mongodb\.net$/i.test(host);
  const protocol = raw.startsWith("mongodb+srv")
    ? "mongodb+srv"
    : raw.startsWith("mongodb:")
      ? "mongodb"
      : "other";
  console.log("file=present");
  console.log("configured=true");
  console.log(`protocol=${protocol}`);
  console.log(`host=${host}`);
  console.log(`isAtlas=${isAtlas}`);
  console.log(`isLocalhost=${isLocal}`);
  console.log(
    `verdict=${isAtlas ? "approved-atlas" : isLocal ? "localhost-not-intended" : "rejected"}`
  );
} catch {
  console.log("file=present");
  console.log("configured=true");
  console.log("verdict=parse-error");
}
