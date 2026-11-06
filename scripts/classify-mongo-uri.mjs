import fs from "fs";

const path = process.argv[2] || ".env.local";
if (!fs.existsSync(path)) {
  console.log("file=missing");
  process.exit(0);
}
const text = fs.readFileSync(path, "utf8");
const m = text.match(/^MONGODB_URI=(.*)$/m);
if (!m) {
  console.log("uri=missing");
  process.exit(0);
}
const raw = m[1].trim().replace(/^['"]|['"]$/g, "");
const protocol = raw.startsWith("mongodb+srv")
  ? "mongodb+srv"
  : raw.startsWith("mongodb:")
    ? "mongodb"
    : "other";
try {
  const normalized = raw.replace(/^mongodb\+srv/, "mongodb");
  const u = new URL(normalized);
  const host = u.hostname;
  const db = (u.pathname || "/").slice(1).split("?")[0] || "(none)";
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost");
  const isAtlas = /\.mongodb\.net$/i.test(host);
  console.log(`protocol=${protocol}`);
  console.log(`host=${host}`);
  console.log(`db=${db}`);
  console.log(`isLocalhost=${isLocal}`);
  console.log(`isAtlas=${isAtlas}`);
  console.log(
    `verdict=${isLocal ? "safe-local" : isAtlas ? "shared-or-atlas-do-not-use" : "uncertain-do-not-use"}`
  );
} catch {
  console.log("parse_error=true");
  console.log("verdict=uncertain-do-not-use");
}
