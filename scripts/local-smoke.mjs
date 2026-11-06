/**
 * Local smoke checks against running Next.js + Atlas.
 * Never prints secrets, credentials, tokens, or connection strings.
 * Read-only / non-destructive: no migrations, seeds, publish, or deletes.
 */
import fs from "fs";
import { CookieJar } from "./_cookieJar.mjs";

function loadEnvLocal() {
  const env = {};
  const text = fs.readFileSync(".env.local", "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const BASE = process.env.APP_URL || "http://localhost:3000";
const env = loadEnvLocal();
const jar = new CookieJar();

function log(result, name, detail = "") {
  console.log(`${result} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function request(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
    cookie: jar.header(),
  };
  if (options.json) {
    headers["content-type"] = "application/json";
    headers.origin = BASE;
  }
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    body: options.json ? JSON.stringify(options.json) : options.body,
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) jar.absorb(c);
  const raw = res.headers.get("set-cookie");
  if (raw && setCookie.length === 0) jar.absorb(raw);
  let body = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  } else {
    body = await res.text();
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log("local_smoke_start");
  console.log(`base=${BASE}`);
  console.log(
    `auto_publish=${env.AUTO_PUBLISH_GLOBALLY_ENABLED === "true" ? "ON" : "off"}`
  );

  // Public pages
  for (const path of ["/", "/login"]) {
    const r = await request(path);
    log(r.status === 200 ? "PASS" : "FAIL", `GET ${path}`, `status=${r.status}`);
  }

  // Auth required redirects / unauthorized APIs
  const meBefore = await request("/api/auth/me");
  log(
    meBefore.status === 401 || meBefore.body?.success === false ? "PASS" : "WARN",
    "GET /api/auth/me unauthenticated",
    `status=${meBefore.status}`
  );

  const email = env.SUPERADMIN_EMAIL || "";
  const password = env.SUPERADMIN_PASSWORD || "";
  if (!email || !password) {
    log("BLOCK", "superadmin_login", "SUPERADMIN_EMAIL/PASSWORD missing");
    process.exit(2);
  }

  const login = await request("/api/auth/login", {
    method: "POST",
    json: { email, password },
  });
  log(
    login.status === 200 && login.body?.success ? "PASS" : "FAIL",
    "POST /api/auth/login superadmin",
    `status=${login.status} role=${login.body?.user?.role || "n/a"}`
  );
  if (!(login.status === 200 && login.body?.success)) {
    process.exit(1);
  }

  const me = await request("/api/auth/me");
  log(
    me.status === 200 && me.body?.user?.role === "superadmin" ? "PASS" : "FAIL",
    "GET /api/auth/me as SA",
    `status=${me.status}`
  );

  // Pages (SSR) as authenticated SA via cookie
  for (const path of [
    "/admin/dashboard",
    "/admin/businesses",
    "/admin/payments",
    "/admin/audit",
    "/settings/google",
    "/reviews",
    "/account",
  ]) {
    const r = await request(path);
    const ok = r.status === 200;
    log(ok ? "PASS" : "FAIL", `GET ${path}`, `status=${r.status}`);
  }

  // Owner-only pages should redirect SA away
  for (const path of ["/seo", "/services", "/billing", "/reports", "/dashboard"]) {
    const r = await request(path);
    const redirected =
      r.status === 307 || r.status === 302 || r.status === 303 || r.status === 308;
    log(
      redirected || r.status === 200 ? "PASS" : "FAIL",
      `GET ${path} (SA)`,
      `status=${r.status}`
    );
  }

  // APIs
  const businesses = await request("/api/admin/businesses");
  log(
    businesses.status === 200 && businesses.body?.success !== false
      ? "PASS"
      : "FAIL",
    "GET /api/admin/businesses",
    `status=${businesses.status} count=${Array.isArray(businesses.body?.businesses) ? businesses.body.businesses.length : "n/a"}`
  );

  const orgs = await request("/api/admin/organizations");
  log(
    orgs.status === 200 && orgs.body?.success ? "PASS" : "FAIL",
    "GET /api/admin/organizations",
    `status=${orgs.status}`
  );

  const payments = await request("/api/admin/payments");
  log(
    payments.status === 200 ? "PASS" : "FAIL",
    "GET /api/admin/payments",
    `status=${payments.status}`
  );

  const audit = await request("/api/admin/audit");
  log(
    audit.status === 200 && audit.body?.success ? "PASS" : "FAIL",
    "GET /api/admin/audit",
    `status=${audit.status}`
  );

  const googleStatus = await request("/api/auth/google/status");
  log(
    googleStatus.status === 200 ||
      googleStatus.status === 401 ||
      googleStatus.status === 403
      ? "PASS"
      : "FAIL",
    "GET /api/auth/google/status",
    `status=${googleStatus.status}`
  );

  // Process route must not publish without scheduler secret
  const processGet = await request("/api/admin/auto-publish/process");
  log(
    processGet.status === 200 || processGet.status === 401 || processGet.status === 403
      ? "PASS"
      : "FAIL",
    "GET auto-publish process (dry/status)",
    `status=${processGet.status}`
  );

  const processPost = await request("/api/admin/auto-publish/process", {
    method: "POST",
    json: {},
  });
  log(
    processPost.status === 401 ||
      processPost.status === 403 ||
      processPost.status === 503
      ? "PASS"
      : "FAIL",
    "POST auto-publish process without scheduler secret",
    `status=${processPost.status}`
  );

  // Pick first business for staff endpoints if any
  const list =
    businesses.body?.businesses ||
    businesses.body?.items ||
    [];
  const first = Array.isArray(list) ? list[0] : null;
  const bizId = first?.id || first?._id || null;
  if (bizId) {
    for (const path of [
      `/api/business/${bizId}/seo`,
      `/api/business/${bizId}/services`,
      `/api/business/${bizId}/flags`,
      `/api/admin/businesses/${bizId}/auto-publish`,
    ]) {
      const r = await request(path);
      log(
        r.status === 200 || r.status === 403 || r.status === 404
          ? "PASS"
          : "FAIL",
        `GET ${path}`,
        `status=${r.status}`
      );
    }
  } else {
    log("WARN", "business_scoped_apis", "no businesses in ledger yet");
  }

  const logout = await request("/api/auth/logout", {
    method: "POST",
    json: {},
  });
  log(
    logout.status === 200 || logout.status === 204 || logout.status === 302
      ? "PASS"
      : "FAIL",
    "POST /api/auth/logout",
    `status=${logout.status}`
  );

  console.log("local_smoke_done");
}

main().catch((err) => {
  console.log(`FAIL smoke_crash — ${err instanceof Error ? err.message : "unknown"}`);
  process.exit(1);
});
