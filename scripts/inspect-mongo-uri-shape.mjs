import fs from "fs";

const path = process.argv[2] || ".env.local";
const text = fs.readFileSync(path, "utf8");
const m = text.match(/^MONGODB_URI=(.*)$/m);
const raw = (m ? m[1] : "").trim().replace(/^['"]|['"]$/g, "");
console.log(`has_key=${Boolean(m)}`);
console.log(`length=${raw.length}`);
console.log(`starts_mongodb=${raw.startsWith("mongodb")}`);
console.log(`starts_srv=${raw.startsWith("mongodb+srv")}`);
console.log(
  `has_placeholder=${/<user>|<password>|<cluster>|REPLACE_/i.test(raw)}`
);
console.log(`has_at=${raw.includes("@")}`);
console.log(`has_mongodb_net=${/\.mongodb\.net/i.test(raw)}`);
if (raw) {
  try {
    const u = new URL(raw.replace(/^mongodb\+srv/, "mongodb"));
    console.log(`parse_ok=true`);
    console.log(`host=${u.hostname}`);
    console.log(`isAtlas=${/\.mongodb\.net$/i.test(u.hostname)}`);
  } catch (err) {
    console.log(`parse_ok=false`);
    console.log(`parse_error=${err instanceof Error ? err.message : "unknown"}`);
  }
} else {
  console.log("empty=true");
}
