# TRONX Review Auto-Reply

Unified **Next.js 16** App Router application for Google Business Profile review management with multi-business Super Admin / owner roles.

**Handover docs:** [`HANDOVER.md`](./HANDOVER.md) · [`PRODUCTION_ENVIRONMENT.md`](./PRODUCTION_ENVIRONMENT.md) · [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md) · [`BACKUP_AND_RECOVERY.md`](./BACKUP_AND_RECOVERY.md) · [`SECURITY_CHECKLIST.md`](./SECURITY_CHECKLIST.md)

## What works in this codebase

- Google OAuth (PKCE, encrypted tokens) — **Super Admin** starts connect (owners may use platform Google)
- Location discovery / upsert — **Super Admin** only; owners see assigned locations
- Review sync (Google list → Mongo), persisted AI drafts, approve/edit, **manual** publish
- **SA Reviews + ORM dashboards are organization-scoped** (active org cookie); Admin APIs remain SA platform tools
- Super Admin business CRUD, lifecycle, location assignment, owners, payments, audit log
- Dedicated `/orm/business/[id]` and `/orm/group/[id]` dashboards
- Staff SEO / GMB service jobs / fake-review flags; owner read-only SEO/services/reports/billing
- Auto-publish **config + safety controls** (atomic claims, scheduler secret, kill switch default OFF)
- Business isolation and plan/lifecycle gates enforced server-side
- Development Mongo policy: **Atlas (`*.mongodb.net`) or localhost** allowed; other remotes need `ALLOW_REMOTE_MONGO=1`

**Not implemented / intentionally gated:** production auto-publish enqueue + scheduler, email password delivery, payment gateways, sentiment analytics, automatic SEO crawling. Permanent business deletion is implemented for Super Admin (archived businesses only; typed confirmations; audit/payments retained).

## Stack

- Next.js 16 (App Router) + TypeScript + Tailwind CSS 4
- MongoDB / Mongoose
- Google Business Profile OAuth + APIs
- OpenAI Chat Completions for drafts only
- Vitest (mocked; no live Google/OpenAI in tests)

## Environment variable names

Copy `.env.example` → `.env.local` (never commit `.env.local`).

| Name | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas `mongodb+srv://…mongodb.net/…` (local Next.js + Atlas) |
| `ALLOW_REMOTE_MONGO` | Escape hatch for non-Atlas / non-localhost hosts in development only |
| `AUTH_SECRET` | Signed user session cookie (≥16 chars) |
| `SUPERADMIN_EMAIL` | Bootstrap Super Admin email (only when users collection is empty) |
| `SUPERADMIN_PASSWORD` | Bootstrap Super Admin password (same gate) |
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Must match Google Cloud (local: `http://localhost:3000/api/auth/google/callback`) |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | 32-byte key (64 hex or base64) for token encryption at rest |
| `OPENAI_API_KEY` | Server-side draft generation |
| `OPENAI_MODEL` | Optional (default `gpt-4o-mini`) |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Optional outlet photo library |
| `APP_URL` | App base URL for OAuth redirects |
| `ALLOW_MIGRATE_APPLY` | Must be `1` to allow migration `--apply` (indexes only) |

Never use `NEXT_PUBLIC_*` for secrets. Production sets `secure` cookies when `NODE_ENV=production`. Full production checklist: [`PRODUCTION_ENVIRONMENT.md`](./PRODUCTION_ENVIRONMENT.md).

## Local setup

Intended architecture: **Next.js on Windows (`npm run dev`) + MongoDB Atlas**. No Docker. No local MongoDB requirement.

```bash
cp .env.example .env.local
# Set MONGODB_URI to your Atlas mongodb+srv:// URI (never commit .env.local)
npm install
npm run typecheck
npm test
npm run dev
```

Development accepts Atlas (`*.mongodb.net`) or localhost. Do not commit credentials.

### First Super Admin

1. Leave the `users` collection empty.
2. Set `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` in `.env.local`.
3. Sign in at `/login` with those credentials once — creates the Super Admin.
4. Remove or rotate bootstrap env values after first login.

### Connect Google (Super Admin)

1. Register redirect URI `http://localhost:3000/api/auth/google/callback`.
2. Sign in as Super Admin → **GMB → Connection** (`/gmb`) → Connect Google.
3. Discover locations under **GMB → Locations** (Super Admin). Fetch reviews from a location detail page (explicit action only).

### Create first business and owner

1. Super Admin → **Businesses** (`/admin/businesses`) or **Onboarding** (`/admin/onboarding`).
2. Create business: name, org id (from Google workspace cookie / admin form), brand voice, language, reply preference (auto is **stored only** — not implemented).
3. Assign **unassigned** locations explicitly (never bulk-auto).
4. Optionally set owner email + password (≥8 chars). Share the password **out-of-band** — this app does not send email.
5. Owner signs in at `/login` → `/orm` (scoped metrics + settings) and `/orm/reviews` (Inbox / Drafts / Published for assigned businesses only).

### Manual owner onboarding steps that remain

- Password handoff is manual (no email/reset flow).
- Super Admin must discover locations and assign them before owners see them.
- Google connection is org-level; owners do not connect Google themselves.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript |
| `npm test` | Vitest (mocked) |

## Migration

`scripts/migrateBusinessBackfill.mjs` reports unassigned locations/reviews and can ensure `businessId` indexes. It **never** auto-assigns locations.

```bash
node --env-file=.env.local scripts/migrateBusinessBackfill.mjs
ALLOW_MIGRATE_APPLY=1 node --env-file=.env.local scripts/migrateBusinessBackfill.mjs --apply
```

Only run `--apply` against a **positively identified non-production** database. Classify first with `node scripts/classifyMongoUri.mjs` (prints labels only, not the URI).

## Indexes (created by Mongoose / migration)

- Locations: `{ orgId, googleLocationName }` unique; `businessId`
- Reviews: `{ orgId, googleReviewName }` unique; `businessId`; `{ locationId, updateTime }`
- Businesses: `{ name, orgId }`; `orgId`; `ownerUserId`; `active`
- Users: unique `email`; `role`

## Security notes

- Provisional org cookie alone cannot authorize protected business ops (integrity ≠ authorization).
- Super Admin switches the active Google workspace only via `POST /api/admin/organizations/select` or a completed OAuth callback — not by forging cookies or passing `orgId` on OAuth start.
- Location discovery and OAuth start require Super Admin.
- Inactive owners/businesses are denied owner workspace access.
- Manual publish validates ownership and only updates Mongo after Google success.
- Cookie-authenticated mutations check `Origin`/`Referer` when present (SameSite=Lax is the primary CSRF control). OAuth callback GET is exempt (Google redirect).
- Automatic publishing is **not** implemented.
- Audit events are structured JSON lines on stdout (`type:"audit"`). They are **not** tamper-proof.

## Rate-limit limitations

Login and AI draft throttles are **process-local in-memory**. Multi-instance or serverless deployments do not share counters — each instance enforces independently. Plan a shared store before high-traffic production if abuse resistance must be cluster-wide.

## Deployment safeguards

Prefer a **unified Next.js** host (e.g. Vercel or similar) with MongoDB Atlas. The old Vercel-frontend + Render-backend split is **retired** in favor of this app.

### Staging vs production

- Use **separate** MongoDB databases, OAuth clients / redirect URIs, and `AUTH_SECRET` / token encryption keys for staging and production.
- Never point a staging app at a production Google Business Profile or customer listings without explicit written authorization.
- Do not run live publish tests against customer locations unless authorized.

### Secrets rotation

- Rotate `AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `OPENAI_API_KEY`, and bootstrap Super Admin credentials on a schedule or after suspected exposure.
- Rotating `AUTH_SECRET` invalidates signed user and org cookies (users must sign in again; Super Admin must re-select / reconnect org context).
- Rotating the token encryption key requires reconnecting Google (existing ciphertext will not decrypt).

### Database backup and restore

- Backups and restores are an **operator responsibility** (e.g. Atlas continuous backup). This repository does not ship or verify backup infrastructure.
- Before restore drills, confirm the target URI with `node scripts/classifyMongoUri.mjs` (labels only — never print full secrets in tickets).

### Migrations

- Dry-run first: `node --env-file=.env.local scripts/migrateBusinessBackfill.mjs`
- Apply indexes only against a **positively identified non-production** database with `ALLOW_MIGRATE_APPLY=1` and `--apply`.
- Migrations never auto-assign locations or publish reviews.

### Product limitations (current)

- No automatic publishing (even if `replyMode=auto` is stored).
- No email delivery for owner passwords or resets (out-of-band only).
- No org-per-admin allowlist (deployment-scoped Super Admin operators).
- Process-local rate limits as noted above.
- No dedicated pending-approvals queue (use Reviews “Needs reply” / unreplied filter).
- No sentiment analytics or AI summary dashboards.
- Legacy risk-scanner UI/service was not ported into this Next.js app (manual publish + DEMO/TEST sanitization remain).

Do not deploy until secrets, redirect URIs, and a confirmed **positively non-production** database (`node scripts/classifyMongoUri.mjs`) are configured. Prefer committing the Next.js tree before staging deploy so the release is reproducible from Git.

### Local demo (Native South & Brew Times)

Operator checklist (no automatic DB writes or live publishing): see [`DEMO_NATIVE_SOUTH_BREW_TIMES.md`](./DEMO_NATIVE_SOUTH_BREW_TIMES.md).
