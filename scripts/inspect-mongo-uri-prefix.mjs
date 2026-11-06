import fs from "fs";

const text = fs.readFileSync(".env.local", "utf8");
const m = text.match(/^MONGODB_URI=(.*)$/m);
const raw = (m ? m[1] : "").trim().replace(/^['"]|['"]$/g, "");
const codes = [...raw.slice(0, 24)].map((c) => c.charCodeAt(0));
console.log(`length=${raw.length}`);
console.log(`first_codes=${codes.join(",")}`);
console.log(`first_printable=${JSON.stringify(raw.slice(0, 24).replace(/[^a-zA-Z0-9:+.@/\-_]/g, "?"))}`);
console.log(`includes_srv_token=${raw.includes("mongodb+srv")}`);
console.log(`includes_mongodb_colon=${raw.includes("mongodb:")}`);
// Common mistake: pasted without scheme
console.log(`looks_like_host_only=${/\.mongodb\.net/.test(raw) && !raw.includes("://")}`);
console.log(`has_scheme_separator=${raw.includes("://")}`);
