/**
 * Read-only Google connection / location association inspection.
 * Does not start OAuth, discovery, or review sync.
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

function redactEmail(email) {
  const s = String(email || "");
  if (!s.includes("@")) return s ? "(set)" : "(none)";
  const [u, d] = s.split("@");
  return `${u.slice(0, 2)}***@${d}`;
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

await request("/api/auth/login", {
  method: "POST",
  json: { email: env.SUPERADMIN_EMAIL, password: env.SUPERADMIN_PASSWORD },
});

const orgs = await request("/api/admin/organizations");
const orgList = orgs.body?.organizations || [];
console.log(`org_count=${orgList.length} activeOrgId=${orgs.body?.activeOrgId ? "set" : "none"}`);

const bizPre = await request("/api/admin/businesses");
const businessesPre = bizPre.body?.businesses || [];
const primaryBizOrg =
  businessesPre.find((b) => Array.isArray(b.locationIds) && b.locationIds.length > 0)
    ?.orgId || businessesPre[0]?.orgId || null;

// Prefer business-linked org for accurate location association readout.
let orgId = primaryBizOrg || orgs.body?.activeOrgId || null;
if (orgId) {
  const sel = await request("/api/admin/organizations/select", {
    method: "POST",
    json: { orgId },
  });
  console.log(
    `selected_org_for_status status=${sel.status} success=${Boolean(sel.body?.success)} from_business=${Boolean(primaryBizOrg)}`
  );
}

const status = await request("/api/auth/google/status");
console.log(
  `google_status http=${status.status} success=${Boolean(status.body?.success)} oauthConfigured=${Boolean(status.body?.oauthConfigured)}`
);
const conn = status.body?.connection;
if (conn) {
  console.log(
    `connection status=${conn.status || "n/a"} source=${conn.connectionSource || "n/a"} email=${redactEmail(conn.email)}`
  );
} else {
  console.log("connection=null");
}

const locs = await request("/api/google/locations");
console.log(`locations_list http=${locs.status}`);
const rows = locs.body?.locations || [];
console.log(`location_count=${Array.isArray(rows) ? rows.length : "n/a"}`);
if (Array.isArray(rows)) {
  let assigned = 0;
  let unassigned = 0;
  for (const loc of rows.slice(0, 30)) {
    const hasBiz = Boolean(loc.businessId || loc.assigned);
    if (hasBiz) assigned += 1;
    else unassigned += 1;
  }
  console.log(
    `sampled_assigned=${assigned} sampled_unassigned=${unassigned} sample_size=${Math.min(rows.length, 30)}`
  );
}

const biz = await request("/api/admin/businesses");
const businesses = biz.body?.businesses || [];
for (const b of businesses) {
  console.log(
    `business_location_link name=${JSON.stringify(b.name)} locations=${(b.locationIds || []).length} status=${b.status || "n/a"}`
  );
}

console.log(
  "note=No discovery/sync/OAuth start performed. Reconnect was not triggered."
);
