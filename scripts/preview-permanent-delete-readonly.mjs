/**
 * Read-only: login as SA, GET permanent-delete preview. Never POST delete.
 */
import { readFileSync, existsSync } from "fs";

function loadEnv() {
  const env = {};
  if (!existsSync(".env.local")) return env;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[trimmed.slice(0, eq).trim()] = v;
  }
  return env;
}

const env = loadEnv();
const base = "http://localhost:3000";
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base },
  body: JSON.stringify({
    email: env.SUPERADMIN_EMAIL,
    password: env.SUPERADMIN_PASSWORD,
  }),
});
const set = typeof login.headers.getSetCookie === "function"
  ? login.headers.getSetCookie()
  : [];
const cookie = set.map((c) => c.split(";")[0]).join("; ");
const bizList = await fetch(`${base}/api/admin/businesses`, {
  headers: { cookie },
});
const bj = await bizList.json();
const biz = (bj.businesses || [])[0];
if (!biz) {
  console.log(JSON.stringify({ ok: false, reason: "no_biz", secrets_printed: false }));
  process.exit(0);
}
const prev = await fetch(
  `${base}/api/admin/businesses/${biz.id}/permanent-delete`,
  { headers: { cookie } }
);
const pj = await prev.json();
console.log(
  JSON.stringify({
    login_ok: login.ok,
    biz_name: biz.name,
    biz_status: biz.status,
    preview_http: prev.status,
    canDelete: pj.preview?.canDelete ?? null,
    blockers: pj.preview?.blockers ?? [pj.message],
    delete_button_eligible: biz.status === "archived",
    secrets_printed: false,
  })
);
