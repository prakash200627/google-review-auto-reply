/**
 * Read-only inventory of businesses/owners via running app APIs.
 * Never prints emails in full if they look like production; redacts middle.
 * No creates/updates/deletes.
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
  if (u.length <= 2) return `**@${d}`;
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

const login = await request("/api/auth/login", {
  method: "POST",
  json: { email: env.SUPERADMIN_EMAIL, password: env.SUPERADMIN_PASSWORD },
});
if (!(login.status === 200 && login.body?.success)) {
  console.log(`login_failed status=${login.status}`);
  process.exit(1);
}
console.log("login=ok role=superadmin");

const biz = await request("/api/admin/businesses");
const list = biz.body?.businesses || biz.body?.items || [];
console.log(`business_count=${list.length}`);

let dedicatedTestCandidates = 0;
let withOwner = 0;
let activeWithOwner = 0;

for (const b of list) {
  const name = String(b.name || "");
  const status = b.status || (b.active === false ? "suspended" : "active");
  const owner = b.ownerEmail || b.ownerUserId ? "yes" : "no";
  const plan = b.plan?.code || "n/a";
  const planStatus = b.plan?.status || "n/a";
  const locs = Array.isArray(b.locationIds) ? b.locationIds.length : 0;
  const isDemo = /native south demo/i.test(name);
  const looksTest = /test|sandbox|qa|local|demo/i.test(name) && !isDemo;
  if (owner === "yes") withOwner += 1;
  if (owner === "yes" && status === "active") activeWithOwner += 1;
  if (looksTest) dedicatedTestCandidates += 1;
  console.log(
    [
      `biz name=${JSON.stringify(name)}`,
      `status=${status}`,
      `plan=${plan}/${planStatus}`,
      `owner=${owner}`,
      `ownerEmail=${redactEmail(b.ownerEmail)}`,
      `locations=${locs}`,
      `reviews=${b.reviewCount ?? "n/a"}`,
      `is_native_south_demo=${isDemo}`,
      `looks_dedicated_test=${looksTest}`,
    ].join(" ")
  );
}

const owners = await request("/api/admin/owners");
console.log(`owners_api_status=${owners.status}`);
if (owners.status === 200) {
  const rows = owners.body?.owners || owners.body?.users || [];
  console.log(`owner_rows=${Array.isArray(rows) ? rows.length : "n/a"}`);
  if (Array.isArray(rows)) {
    for (const o of rows.slice(0, 20)) {
      console.log(
        `owner email=${redactEmail(o.email)} active=${o.active} businesses=${Array.isArray(o.businessIds) ? o.businessIds.length : "n/a"}`
      );
    }
  }
}

const orgs = await request("/api/admin/organizations");
console.log(`org_count=${Array.isArray(orgs.body?.organizations) ? orgs.body.organizations.length : "n/a"}`);

console.log(`summary with_owner=${withOwner} active_with_owner=${activeWithOwner} dedicated_test_candidates=${dedicatedTestCandidates}`);
console.log(
  activeWithOwner > 0
    ? "owner_browser_ready=maybe"
    : "owner_browser_ready=no — need dedicated active test business + owner (approval required to create)"
);
