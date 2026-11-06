import { readFileSync, existsSync } from "fs";

if (!existsSync(".env.local")) {
  console.log(JSON.stringify({ present: false }));
  process.exit(0);
}
const t = readFileSync(".env.local", "utf8");
const m = t.match(/^AUTO_PUBLISH_GLOBALLY_ENABLED=(.*)$/m);
let v = (m ? m[1] : "").trim();
if (
  (v.startsWith('"') && v.endsWith('"')) ||
  (v.startsWith("'") && v.endsWith("'"))
) {
  v = v.slice(1, -1);
}
console.log(
  JSON.stringify({
    key_present: Boolean(m),
    kill_switch_enabled: v === "true",
    secrets_printed: false,
  })
);
