/**
 * Diagnose Super Admin SEO/services 403 without printing secrets.
 */
import fs from "fs";
import { CookieJar } from "./_cookieJar.mjs";

function loadEnvLocal() {
  const env = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const BASE = "http://localhost:3000";
const env = loadEnvLocal();
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
console.log(`login=${login.status} role=${login.body?.user?.role || "n/a"}`);

const biz = await request("/api/admin/businesses");
const list = biz.body?.businesses || [];
const id = list[0]?.id;
console.log(`businesses=${list.length} first=${id ? "yes" : "no"}`);
if (!id) process.exit(0);

for (const path of [
  `/api/business/${id}/seo`,
  `/api/business/${id}/services`,
  `/api/business/${id}/flags`,
]) {
  const r = await request(path);
  console.log(
    `${path} status=${r.status} code=${r.body?.code || ""} msg=${String(r.body?.message || "").slice(0, 120)}`
  );
}
