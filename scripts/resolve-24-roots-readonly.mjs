/**
 * Read-only: resolve business "24 Roots" / business named like 24 Roots
 * and its assigned Google location id(s). No mutations.
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
console.log("login=ok");

const bizRes = await request("/api/admin/businesses");
const list = bizRes.body?.businesses || bizRes.body?.items || [];
const matches = list.filter((b) => {
  const name = String(b.name || "");
  return (
    /^24\s*roots$/i.test(name.trim()) ||
    /24\s*roots/i.test(name) ||
    String(b._id || b.id) === "24"
  );
});

console.log(`business_total=${list.length}`);
console.log(`roots_matches=${matches.length}`);

for (const b of matches) {
  const id = String(b._id || b.id);
  const locIds = Array.isArray(b.locationIds)
    ? b.locationIds.map(String)
    : [];
  console.log(
    JSON.stringify({
      businessId: id,
      name: b.name,
      active: b.active,
      locationIds: locIds,
      locationCount: locIds.length,
    })
  );
}

if (matches.length === 0) {
  // Fallback: print names containing 24 for operator clarity (no secrets)
  const near = list
    .filter((b) => /24|root/i.test(String(b.name || "")))
    .map((b) => ({ id: String(b._id || b.id), name: b.name }));
  console.log(`near_name_matches=${JSON.stringify(near)}`);
  process.exit(2);
}

const primary = matches[0];
const businessId = String(primary._id || primary.id);
const locationIds = Array.isArray(primary.locationIds)
  ? primary.locationIds.map(String)
  : [];

if (locationIds.length === 0) {
  // Try admin locations filtered by business
  const locRes = await request(
    `/api/admin/locations?includeAssigned=1&q=${encodeURIComponent("24 Roots")}`
  );
  const locs = locRes.body?.locations || locRes.body?.items || [];
  console.log(`admin_locations_q_count=${locs.length}`);
  for (const loc of locs.slice(0, 10)) {
    console.log(
      JSON.stringify({
        locationId: String(loc.id || loc._id),
        title: loc.title,
        businessId: loc.businessId ? String(loc.businessId) : null,
      })
    );
  }
  process.exit(locationIds.length === 0 && locs.length === 0 ? 3 : 0);
}

if (locationIds.length !== 1) {
  console.log(
    `warn_multiple_locations=${locationIds.length} — operator must pick exactly one`
  );
}

console.log(`RESOLVED_BUSINESS_ID=${businessId}`);
console.log(`RESOLVED_LOCATION_ID=${locationIds[0] || ""}`);
process.exit(0);
