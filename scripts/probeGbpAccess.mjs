/**
 * One-off read-only probe of GBP Account Management / Business Info / Reviews APIs.
 * Prints only status codes and counts — never tokens or secrets.
 * Usage: node --env-file=.env.local scripts/probeGbpAccess.mjs
 */
import mongoose from "mongoose";
import { createDecipheriv } from "crypto";

const uri = process.env.MONGODB_URI;
const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const encKeyRaw = (process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "").trim();

function parseKey(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("bad encryption key length");
  return key;
}

function decryptToken(payload, key) {
  const [ver, ivB64, tagB64, dataB64] = payload.split(":");
  if (ver !== "v1") throw new Error("bad token version");
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

async function refreshIfNeeded(doc, key) {
  const access = decryptToken(doc.encryptedAccessToken, key);
  const refresh = decryptToken(doc.encryptedRefreshToken, key);
  const expires = doc.accessTokenExpiresAt
    ? new Date(doc.accessTokenExpiresAt).getTime()
    : 0;
  if (expires > Date.now() + 60_000) return access;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    console.log("TOKEN_REFRESH", res.status, data.error || "failed");
    return null;
  }
  console.log("TOKEN_REFRESH", res.status, "ok");
  return data.access_token;
}

async function probe(label, url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const text = await res.text();
  let summary = "";
  try {
    const json = JSON.parse(text);
    if (json.error) {
      summary = `${json.error.status || ""} ${String(json.error.message || "").slice(0, 120)}`;
    } else if (Array.isArray(json.accounts)) {
      summary = `accounts=${json.accounts.length}`;
    } else if (Array.isArray(json.locations)) {
      summary = `locations=${json.locations.length}`;
    } else if (Array.isArray(json.reviews)) {
      summary = `reviews=${json.reviews.length} total=${json.totalReviewCount ?? "?"}`;
    } else {
      summary = `keys=${Object.keys(json).join(",")}`;
    }
  } catch {
    summary = `non-json len=${text.length}`;
  }
  console.log(label, res.status, summary);
  return { status: res.status, text };
}

async function main() {
  if (!uri || !clientId || !clientSecret || !encKeyRaw) {
    console.log("PROBE_SKIP missing env");
    process.exit(0);
  }

  const key = parseKey(encKeyRaw);
  await mongoose.connect(uri, { bufferCommands: false });
  const col = mongoose.connection.collection("googleconnections");
  const doc = await col.findOne(
    { status: "active" },
    {
      projection: {
        encryptedAccessToken: 1,
        encryptedRefreshToken: 1,
        accessTokenExpiresAt: 1,
        googleAccountEmail: 1,
      },
    }
  );
  if (!doc?.encryptedAccessToken || !doc?.encryptedRefreshToken) {
    console.log("PROBE_SKIP no_active_connection");
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log("CONNECTION_FOUND email_present", Boolean(doc.googleAccountEmail));
  const accessToken = await refreshIfNeeded(doc, key);
  if (!accessToken) {
    await mongoose.disconnect();
    process.exit(1);
  }

  const accountsRes = await probe(
    "ACCOUNTS_LIST",
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20",
    accessToken
  );

  let accountName = null;
  let locationParent = null;
  try {
    const json = JSON.parse(accountsRes.text);
    accountName = json.accounts?.[0]?.name || null;
  } catch {
    /* ignore */
  }

  if (accountName) {
    const locUrl =
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations` +
      `?pageSize=10&readMask=name,title`;
    const locRes = await probe("LOCATIONS_LIST", locUrl, accessToken);
    try {
      const json = JSON.parse(locRes.text);
      const loc = json.locations?.[0];
      if (loc?.name && accountName) {
        const locId = loc.name.replace(/^locations\//, "");
        const accId = accountName.replace(/^accounts\//, "");
        locationParent = `accounts/${accId}/locations/${locId}`;
      }
    } catch {
      /* ignore */
    }
  } else {
    console.log("LOCATIONS_LIST skipped (no account)");
  }

  if (locationParent) {
    await probe(
      "REVIEWS_LIST",
      `https://mybusiness.googleapis.com/v4/${locationParent}/reviews?pageSize=5&orderBy=updateTime%20desc`,
      accessToken
    );
  } else {
    console.log("REVIEWS_LIST skipped (no location)");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.log("PROBE_ERROR", err instanceof Error ? err.message : "unknown");
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
