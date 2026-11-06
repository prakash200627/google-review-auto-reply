/**
 * ORM draft workflow against one stored review for business 24.
 * Generate → edit/save → approve. NEVER publishes to Google.
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
const BUSINESS_ID = "6aec4270d7e96d87e5543bab";
const env = loadEnv();
const jar = new CookieJar();

async function request(path, options = {}) {
  const headers = { cookie: jar.header(), ...(options.headers || {}) };
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    headers.origin = BASE;
  }
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    body:
      options.json !== undefined ? JSON.stringify(options.json) : undefined,
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
const biz = (bizRes.body?.businesses || []).find(
  (b) => String(b._id || b.id) === BUSINESS_ID
);
const orgId = biz?.orgId ? String(biz.orgId) : null;
if (!orgId) {
  console.log("missing_org_for_business_24");
  process.exit(1);
}
const select = await request("/api/admin/organizations/select", {
  method: "POST",
  json: { orgId },
});
console.log(`org_select_status=${select.status}`);
if (select.status >= 400) {
  console.log("org_select_failed");
  process.exit(1);
}

const published = await request(
  `/api/reviews/inbox?businessId=${BUSINESS_ID}&replyStatus=replied&pageSize=1`
);
const review = published.body?.reviews?.[0];
if (!review?.id) {
  console.log("no_stored_review_for_draft_test");
  process.exit(2);
}
console.log(`reviewId=${review.id}`);
console.log(`had_public_reply_before=${Boolean(review.replyComment?.trim())}`);
console.log(`draftStatus_before=${review.draftStatus || "none"}`);

const gen = await request(`/api/reviews/${encodeURIComponent(review.id)}/draft`, {
  method: "POST",
  json: { forceRegenerate: true },
});
console.log(`generate_status=${gen.status} success=${Boolean(gen.body?.success)}`);
console.log(`generate_code=${gen.body?.code || ""}`);
if (!(gen.status === 200 && gen.body?.success && gen.body?.draft)) {
  console.log(`generate_message=${JSON.stringify(gen.body?.message || "")}`);
  console.log("draft_generate_failed — stopping before approve/publish");
  process.exit(3);
}
console.log(`draft_len=${String(gen.body.draft).length}`);
console.log(`persisted=${Boolean(gen.body.persisted)}`);

const edited = `${String(gen.body.draft).trim()}\n\n[TRONX draft edit — not published]`;
const save = await request(`/api/reviews/${encodeURIComponent(review.id)}/draft`, {
  method: "PATCH",
  json: { draftText: edited, approve: false },
});
console.log(`save_status=${save.status} success=${Boolean(save.body?.success)}`);
console.log(`save_draftStatus=${save.body?.draftStatus || ""}`);

const approve = await request(
  `/api/reviews/${encodeURIComponent(review.id)}/draft`,
  {
    method: "PATCH",
    json: { draftText: edited, approve: true },
  }
);
console.log(
  `approve_status=${approve.status} success=${Boolean(approve.body?.success)}`
);
console.log(`approve_draftApproved=${Boolean(approve.body?.draftApproved)}`);
console.log(`approve_draftStatus=${approve.body?.draftStatus || ""}`);

const drafts = await request(
  `/api/reviews/inbox?businessId=${BUSINESS_ID}&replyStatus=drafts&pageSize=5`
);
const inDrafts = (drafts.body?.reviews || []).some((r) => r.id === review.id);
console.log(`appears_in_drafts_tab_query=${inDrafts}`);

const stillPublished = await request(
  `/api/reviews/inbox?businessId=${BUSINESS_ID}&replyStatus=replied&pageSize=5&q=`
);
// Confirm public reply text unchanged by checking the same review via unreplied=false list
const again = await request(
  `/api/reviews/inbox?businessId=${BUSINESS_ID}&replyStatus=any&pageSize=50`
);
const row = (again.body?.reviews || []).find((r) => r.id === review.id);
console.log(`replyComment_unchanged=${row?.replyComment === review.replyComment}`);
console.log(`draftApproved_now=${Boolean(row?.draftApproved)}`);
console.log(`draftStatus_now=${row?.draftStatus || ""}`);
console.log("publish_skipped=true (explicit operator rule)");
console.log("orm_draft_workflow_nopublish_done");
process.exit(0);
