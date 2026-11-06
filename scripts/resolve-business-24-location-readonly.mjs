/**
 * Read-only: find location(s) assigned to business named "24"
 * and confirm any titled like "24 Roots". No mutations.
 */
import fs from "fs";
import { CookieJar } from "./_cookieJar.mjs";

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const BASE = process.env.APP_URL || "http://localhost:3000";
const env = loadEnv();
const jar = new CookieJar();

async function request(path, options = {}) {
  const headers = { cookie: jar.header(), ...(options.headers || {}) };
  if (options.json) {
    headers["content-type"] = "application/json";
    headers.origin = BASE;
  }
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    body: options.json ? JSON.stringify(options.json) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() || []) jar.absorb(c);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const login = await request("/api/auth/login", {
  method: "POST",
  json: { email: env.SUPERADMIN_EMAIL, password: env.SUPERADMIN_PASSWORD },
});
if (!(login.status === 200 && login.body?.success)) {
  console.log(`login_failed status=${login.status}`);
  process.exit(1);
}

const bizRes = await request("/api/admin/businesses");
const list = bizRes.body?.businesses || [];
const biz = list.find((b) => String(b.name || "").trim() === "24");
if (!biz) {
  console.log("business_24_not_found");
  process.exit(2);
}
const businessId = String(biz._id || biz.id);
console.log(`businessId=${businessId}`);
console.log(`businessName=${biz.name}`);
console.log(
  `locationIds_on_business=${JSON.stringify(
    (biz.locationIds || []).map(String)
  )}`
);

const locRes = await request(
  `/api/admin/locations?includeAssigned=1&limit=100&offset=0`
);
console.log(`locations_api_status=${locRes.status}`);
const locs = locRes.body?.locations || locRes.body?.items || [];
console.log(`locations_returned=${locs.length}`);

const forBiz = locs.filter(
  (l) => String(l.businessId || "") === businessId
);
const roots = forBiz.filter((l) =>
  /24\s*roots/i.test(String(l.title || l.name || ""))
);

console.log(`assigned_to_business_24=${forBiz.length}`);
console.log(`titled_24_roots=${roots.length}`);

for (const loc of forBiz) {
  console.log(
    JSON.stringify({
      locationId: String(loc.id || loc._id),
      title: loc.title || loc.name || "",
      businessId: loc.businessId ? String(loc.businessId) : null,
      googleLocationName: loc.googleLocationName || "",
    })
  );
}

const pick = roots[0] || forBiz[0];
if (!pick) {
  console.log("no_assigned_location");
  process.exit(3);
}

console.log(`RESOLVED_BUSINESS_ID=${businessId}`);
console.log(`RESOLVED_LOCATION_ID=${String(pick.id || pick._id)}`);
console.log(`RESOLVED_LOCATION_TITLE=${pick.title || pick.name || ""}`);
process.exit(0);
