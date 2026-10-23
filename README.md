# Google Review Auto-Reply

Syncs Google Business Profile reviews over OAuth, drafts replies with OpenAI `gpt-4o-mini`, routes risky reviews to a human, and publishes approved replies **directly** through the Google Business Profile API.

Make.com is **not** part of this architecture.

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React + Vite (Vercel) |
| Backend | Node.js + Express (Render) |
| Database | MongoDB Atlas |
| AI | OpenAI SDK (`gpt-4o-mini`) |
| Google | OAuth 2.0 + Business Profile APIs (`business.manage`) |

## Features

- Google OAuth 2.0 with PKCE, encrypted refresh/access tokens, and org-scoped connections
- Location discovery and multi-tenant location linking
- Scheduled review sync (default every 5 minutes) with MongoDB lease coordination
- Idempotent review ingestion and duplicate AI-generation prevention
- Manual / automatic reply modes with existing risk detection
- Direct `accounts.locations.reviews.updateReply` publishing
- Publish attempt tracking, stale reconciliation, and explicit retries
- Dashboard routes: `/dashboard`, `/summary`, `/analysis`, `/pending`, `/reviews`, `/settings/google`

## Local development

### Backend

```bash
cd backend
cp .env.example .env   # fill in values (never commit .env)
npm install
npm start
```

### Frontend

```bash
cd frontend
# optional: VITE_API_URL=http://localhost:5000/api
npm install
npm run dev
```

### Tests and build checks

```bash
cd backend && npm test
cd frontend && npm run lint
cd frontend && npm run build
```

Location duplicate audit (read-only):

```bash
cd backend && npm run audit:locations
```

## Environment variables

See `backend/.env.example` for the full list. Required names:

| Variable | Purpose |
| --- | --- |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Auth token signing |
| `OPENAI_API_KEY` | Fallback OpenAI key |
| `GOOGLE_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth web client secret |
| `GOOGLE_REDIRECT_URI` | Backend callback, e.g. `https://<render>/api/google/oauth/callback` |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | 32-byte AES-256-GCM key (64 hex chars or base64) |
| `FRONTEND_URL` | Origin for post-OAuth redirects |
| `REVIEW_SYNC_INTERVAL_MINUTES` | Sync interval (1–60, default `5`) |
| `PUBLISH_STALE_AFTER_MINUTES` | Stale in-flight publish threshold (default `15`) |
| `CORS_ORIGINS` | Extra production frontend origins |
| `DISABLE_REVIEW_SYNC` | Set `true` to disable the in-process scheduler |

Obsolete Make.com variables (`MAKE_WEBHOOK_SECRET`, `MAKE_PUBLISH_CALLBACK_SECRET`, `MAKE_APPROVED_REPLY_WEBHOOK_URL`) are **not used** and must not be required.

## Google Cloud setup (manual)

1. Create a Google Cloud project and enable:
   - My Business Account Management API
   - My Business Business Information API
   - Google My Business API (reviews v4)
2. Configure the OAuth consent screen. Scope: `https://www.googleapis.com/auth/business.manage` (plus OpenID email/profile for account label).
3. Create an **OAuth 2.0 Web application** client.
4. Add authorized redirect URI(s) matching `GOOGLE_REDIRECT_URI`.
5. Ensure the Google account that will connect owns or manages the Business Profile locations (verified locations are required for review APIs).
6. Business Profile API access may require Google’s partner / API access process for production. Until access is granted, OAuth may succeed while location/review calls fail — treat that as an external blocker.

## OAuth flow

1. Authenticated user opens **Google Connection** (`/settings/google`) and clicks Connect.
2. Backend creates a short-lived OAuth `state` + PKCE verifier bound to the organization.
3. Browser redirects to Google; Google returns to `GET /api/google/oauth/callback`.
4. Backend validates state (expiry + single use), exchanges the code server-side, encrypts tokens at rest, and redirects to the frontend.
5. User discovers locations and connects selected ones to their organization.
6. Access tokens never leave the backend. Missing encryption configuration fails closed (no plaintext token storage).

## Review synchronization

- An in-process scheduler runs in the backend (not the browser).
- Default interval: **5 minutes** (`REVIEW_SYNC_INTERVAL_MINUTES`).
- **Scheduled worker** (`runReviewSyncCycle`): synchronizes every organization that has eligible locations.
- **Manual sync** (`POST /api/google/sync/now`): synchronizes **only** the authenticated organization (JWT). Client-supplied `orgId` cannot retarget another tenant. Rate-limited per org.
- Leases use a unique fencing `ownerId` + `generation` per acquisition (`SyncLease`). Renew/release and location checkpoint writes succeed only while that owner still holds the lease. Stale workers cannot advance watermarks or page tokens after a newer worker takes over.
- Per-org lease keys (`review-sync:org:{orgId}`) allow different organizations to sync without blocking each other; a global cycle lease coordinates scheduled runners.
- Only `syncEnabled` locations with a linked `connectionId` and Business Profile `googleAccountId` are synced.
- **Watermark:** after a **fully successful** pass (zero review-processing failures and zero malformed payloads), `syncWatermarkUpdateTime` stores the newest processed Google `updateTime`. Later syncs paginate newest-first and stop at reviews strictly older than the watermark (equality is re-processed; ingestion is idempotent). If any review fails to process or arrives malformed (missing id/rating/resource name), the previous watermark is retained, `syncPassIncomplete` is set, and the page-token checkpoint is cleared immediately so the next run retries from newest — the watermark never advances past an incomplete pass.
- **Durable incomplete marker:** `Location.syncPassIncomplete` is written as soon as a processing failure or malformed payload is seen (fenced write). If the process crashes before final cleanup, the next run sees this flag, ignores any leftover page token, and restarts from newest with the prior watermark.
- **Malformed payloads:** counted separately from idempotent duplicates (`malformedCount` / `malformedReasons` on the sync result). Operators see a single structured `console.warn` per pass (`event: review_sync_malformed_payload` with `locationId`, `count`, `reasons` only — no review text/PII), plus `Location.lastSyncError` mentioning malformed counts, and `syncPassIncomplete: true` until a clean pass clears it.
- Clean interrupted page chains (no incomplete marker) resume via `syncCheckpointPageToken` without early watermark stop until that chain finishes.
- Reviews are upserted by `googleReviewId` (idempotent). One failing location does not stop others.
- **Residual concurrency:** a database lease cannot cancel an in-flight Google HTTP request. If ownership is lost mid-request, further DB writes are refused; duplicate ingest remains safe. This is **not** exactly-once external I/O.

### Relinking existing locations

Historical `Location` rows created before Google OAuth **do not sync** until an authorized user:

1. Connect Google on **Google Connection**.
2. **Refresh Google locations** (discover).
3. Select and **Connect** each business that should sync.

The app will **not** auto-associate historical locations by name. `googleLocationId` collisions with another organization are rejected. Unlinked locations stay in the DB for history but remain `syncEnabled: false` / without `connectionId` until explicitly linked.

## AI replies and automatic mode (preserved policy)

- Model: OpenAI `gpt-4o-mini` (organization key override still supported).
- **Manual mode:** drafts wait in `/pending` until approve/reject.
- **Auto mode:** non-flagged reviews of **any** star rating (including 1-star) are approved and published immediately.
- Flagged / high-risk reviews always escalate to human review and are **not** auto-published.
- Duplicate deliveries do not create duplicate replies or re-run auto-publish.

## Direct publishing and reconciliation

| Reply status | publishState | Meaning | Next step |
| --- | --- | --- | --- |
| `approved` | `sending` | Google API request in flight | Wait, or reconcile if stale |
| `published` | `published` | Google returned a successful `updateReply` | Done |
| `approved` | `unknown` | Timeout / ambiguous network outcome | Check Google, then Retry Publishing |
| `pending` | `failed` | Definitive failure | Approve again |

- Attempt IDs are hashed; concurrent publishes use atomic claim updates.
- Ambiguous timeouts are **never** auto-retried.
- `POST /api/reply/reconcile-publish` may confirm publication via Google `getReview` when the remote comment matches; otherwise it marks `unknown` without resending.
- `POST /api/reply/retry-publish` is an explicit resend for `unknown` only (Google keeps one reply per review).

Retired Make.com routes respond with **410 Gone** and do not mutate data:

- `POST /api/webhook/review`
- `POST /api/webhook/publish-result`

## Deployment notes (configuration only)

This repository change set does **not** deploy itself. When you are ready to configure staging/production manually:

### Render (backend)

- Set all Google OAuth and encryption variables from `.env.example`.
- Set `FRONTEND_URL` to the Vercel origin.
- Set `NODE_ENV=production`.
- Ensure a single web service keeps the Node process alive so the sync scheduler can run (or run multiple instances — the MongoDB lease coordinates them).
- Do **not** set obsolete Make.com variables.

### Vercel (frontend)

- Set `VITE_API_URL` to the Render API base (`https://<host>/api`).
- Redeploy after backend Google routes are live.

### Safe rollout sequence

1. Configure Google Cloud OAuth + enable APIs.
2. Set Render env vars (including `GOOGLE_TOKEN_ENCRYPTION_KEY`).
3. Deploy backend, confirm `/` reports healthy and OAuth start works.
4. Connect a staging Google account and one location; run **Sync reviews now**.
5. Approve a test reply and confirm it appears on Google.
6. Deploy frontend with the Google Connection page.

## Migration notes

- Existing organizations, users, reviews, and replies are preserved.
- Existing `Location` documents remain; add Business Profile `googleAccountId` + `connectionId` by connecting through the new UI (see Relinking above).
- `GoogleConnection.googleUserSub` is the OIDC subject. Legacy field `GoogleConnection.googleAccountId` stores the **same** OIDC subject for compatibility — it is **not** a GBP `accounts/{id}` (that lives on `Location.googleAccountId`).
- Disconnect attempts Google token revocation (`POST https://oauth2.googleapis.com/revoke`) then deletes local credentials. If revoke is not confirmed, local data is still removed; the user may need to revoke the app under their Google Account permissions.
- No production index builds or data deletes are performed by application startup.
- Historical replies may still show `publishState: "accepted"` from the Make.com era; new publishes use `published` directly.

## Security notes

- JWT auth on all dashboard and Google management routes.
- Manual sync is organization-scoped and rate-limited; it cannot trigger other tenants' Google/AI work.
- OAuth state: cryptographically random, short-lived, single-use, org-bound.
- Return paths allowlisted (no open redirects).
- Tokens encrypted with versioned AES-256-GCM (`v1:` prefix).
- Rate limiting, payload limits, and production CORS allowlisting retained.
- Secrets are never logged or returned in API responses.
