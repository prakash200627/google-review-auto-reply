import fs from "fs";

const path = process.argv[2] || ".env.local";
if (!fs.existsSync(path)) {
  console.log("status=missing_env_file");
  process.exit(0);
}
const text = fs.readFileSync(path, "utf8");
const m = text.match(/^MONGODB_URI=(.*)$/m);
const raw = (m ? m[1] : "").trim().replace(/^['"]|['"]$/g, "");
if (!raw) {
  console.log("status=empty");
  process.exit(0);
}

console.log("status=configured");
console.log(`length=${raw.length}`);
console.log(`starts_mongodb=${raw.startsWith("mongodb")}`);
console.log(`has_scheme=${raw.includes("://")}`);
console.log(`has_mongodb_net=${/\.mongodb\.net/i.test(raw)}`);
console.log(`has_at=${raw.includes("@")}`);

try {
  const normalized = raw.replace(/^mongodb\+srv/, "mongodb");
  const u = new URL(normalized);
  const host = u.hostname;
  const db = (u.pathname || "/").slice(1).split("?")[0] || "(none)";
  const isAtlas = /\.mongodb\.net$/i.test(host);
  const isLocalhost =
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  const protocol = raw.startsWith("mongodb+srv")
    ? "mongodb+srv"
    : raw.startsWith("mongodb:")
      ? "mongodb"
      : "other";
  console.log("parse_ok=true");
  console.log(`protocol=${protocol}`);
  console.log(`host=${host}`);
  console.log(`db=${db.includes("@") ? "(redacted)" : db}`);
  console.log(`isAtlas=${isAtlas}`);
  console.log(`isLocalhost=${isLocalhost}`);
  console.log(`approved=${isAtlas || isLocalhost}`);
} catch {
  console.log("parse_ok=false");
  console.log("status_detail=parse_error");
  console.log(
    "hint=URI must be a full mongodb+srv://user:pass@cluster.mongodb.net/db string; encode special password characters"
  );
  console.log("approved=false");
}
