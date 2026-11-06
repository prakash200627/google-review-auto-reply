/**
 * AUTHORIZED one-time review fetch for business "24" → assigned location only.
 * Steps: login → resolve business/location → select org → GET location title
 * → POST reviews sync once. Never publishes. Never discovers. Never retries on failure.
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
  const raw = res.headers.get("set-cookie");
  if (raw) jar.absorb(raw);
  const ct = res.headers.get("content-type") || "";
  let body = null;
  if (ct.includes("application/json")) {
    body = await res.json().catch(() => ({}));
  } else {
    body = await res.text().catch(() => "");
  }
  return { status: res.status, body };
}

console.log("=== authorized_one_time_fetch_start ===");

const login = await request("/api/auth/login", {
  method: "POST",
  json: { email: env.SUPERADMIN_EMAIL, password: env.SUPERADMIN_PASSWORD },
});
if (!(login.status === 200 && login.body?.success)) {
  console.log(`ABORT login_failed status=${login.status}`);
  process.exit(1);
}
console.log("login=ok");

const bizRes = await request("/api/admin/businesses");
const list = bizRes.body?.businesses || [];
const biz = list.find((b) => String(b.name || "").trim() === "24");
if (!biz) {
  console.log("ABORT business_24_not_found");
  process.exit(2);
}

const businessId = String(biz._id || biz.id);
const orgId = biz.orgId ? String(biz.orgId) : null;
const locationIds = (biz.locationIds || []).map(String);

console.log(`businessId=${businessId}`);
console.log(`orgId=${orgId || "(missing)"}`);
console.log(`locationIds=${JSON.stringify(locationIds)}`);

if (!orgId) {
  console.log("ABORT business_missing_orgId");
  process.exit(3);
}
if (locationIds.length !== 1) {
  console.log(
    `ABORT expected_exactly_one_location got=${locationIds.length}`
  );
  process.exit(4);
}

const locationId = locationIds[0];

// Bind org cookie to the business org (required for Google location routes).
const select = await request("/api/admin/organizations/select", {
  method: "POST",
  json: { orgId },
});
console.log(`org_select_status=${select.status}`);
if (!(select.status === 200 && select.body?.success !== false)) {
  // Some responses use success:true; treat non-2xx as abort
  if (select.status >= 400) {
    console.log(
      `ABORT org_select_failed code=${select.body?.code || "n/a"} message=${select.body?.message || ""}`
    );
    process.exit(5);
  }
}
console.log("org_select=ok");

// Confirm stored location title before live fetch (GET reviews list = stored only).
const stored = await request(
  `/api/google/locations/${encodeURIComponent(locationId)}/reviews`
);
console.log(`stored_reviews_get_status=${stored.status}`);
if (stored.status === 200 && stored.body?.success) {
  console.log(
    `stored_reviews_before=${Array.isArray(stored.body.reviews) ? stored.body.reviews.length : 0}`
  );
} else {
  console.log(
    `stored_reviews_before_unavailable code=${stored.body?.code || "n/a"} message=${stored.body?.message || ""}`
  );
}

// Location list for title confirmation (org-scoped, no Google live call).
const locs = await request("/api/google/locations");
const locList = locs.body?.locations || [];
const match = locList.find((l) => String(l.id) === locationId);
console.log(
  `location_title=${match?.title || "(not_in_list)"} location_id=${locationId}`
);

const title = String(match?.title || "");
if (title && !/24\s*roots/i.test(title) && title !== "24") {
  console.log(
    `WARN title_does_not_match_24_roots title=${JSON.stringify(title)} — continuing because this is the sole location assigned to business 24 as authorized`
  );
}

console.log("=== LIVE_FETCH_ONCE starting ===");
const fetchOnce = await request(
  `/api/google/locations/${encodeURIComponent(locationId)}/reviews`,
  { method: "POST", json: {} }
);
console.log(`fetch_status=${fetchOnce.status}`);
console.log(`fetch_success=${Boolean(fetchOnce.body?.success)}`);
console.log(`fetch_code=${fetchOnce.body?.code || ""}`);
console.log(
  `fetch_message=${JSON.stringify(fetchOnce.body?.message || "")}`
);
console.log(`upserted=${fetchOnce.body?.upserted ?? "n/a"}`);
console.log(
  `totalReviewCount=${fetchOnce.body?.totalReviewCount ?? "n/a"}`
);
console.log(
  `reviews_returned=${Array.isArray(fetchOnce.body?.reviews) ? fetchOnce.body.reviews.length : 0}`
);

if (!(fetchOnce.status === 200 && fetchOnce.body?.success)) {
  console.log("=== LIVE_FETCH_ONCE failed — no retry ===");
  process.exit(6);
}

console.log("=== LIVE_FETCH_ONCE ok ===");

// Post-check: inbox scoped to business 24
const inbox = await request(
  `/api/reviews/inbox?businessId=${encodeURIComponent(businessId)}&pageSize=5&includeMetrics=1`
);
console.log(`inbox_status=${inbox.status}`);
console.log(`inbox_total=${inbox.body?.total ?? "n/a"}`);
console.log(
  `inbox_metrics=${JSON.stringify(inbox.body?.metrics || null)}`
);

console.log("=== authorized_one_time_fetch_done ===");
process.exit(0);
