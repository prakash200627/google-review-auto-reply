# TRONX — Client / ops handover

**Date:** 2026-11-06  
**Release posture:** Feature-complete for navigation, Reviews workspace, ORM business/group dashboards, org isolation, GMB, Admin. Final hardening pass includes **SA Reviews organization scoping**.

Related docs:

- `README.md` — product overview + local setup  
- `PRODUCTION_ENVIRONMENT.md` — env var checklist (names only)  
- `PRODUCTION_DEPLOYMENT.md` — build/start/deploy steps  
- `BACKUP_AND_RECOVERY.md` — Atlas backup/restore  
- `SECURITY_CHECKLIST.md` — pre-cutover security  
- `DEMO_NATIVE_SOUTH_BREW_TIMES.md` — local demo checklist (non-prod)

---

## 1. Architecture

```
Browser → Next.js 16 App Router (SSR + Route Handlers)
        → Auth (signed cookies) + active org cookie (SA)
        → MongoDB (Mongoose)
        ↘ Google Business Profile APIs (server-only encrypted tokens)
        ↘ OpenAI (draft generation only)
        ↘ Cloudinary (optional media)
```

| Workspace | Path | Audience |
| --- | --- | --- |
| ORM | `/orm`, `/orm/business/[id]`, `/orm/group/[id]`, `/orm/reviews` | SA (org-scoped) + BA (assignments) |
| GMB | `/gmb`, `/gmb/locations` | SA connects Google; BA view/status |
| Admin | `/admin/*` | **SA only** — platform management |
| Account | `/account` | Authenticated users |

---

## 2. Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js ≥ 20.9 |
| App | Next.js 16, React 19, TypeScript, Tailwind 4 |
| DB | MongoDB / Mongoose 9 (Atlas + replica set for transactions) |
| Auth | Email/password; HMAC session cookies |
| Google | OAuth PKCE + GBP APIs |
| AI | OpenAI Chat Completions |
| Tests | Vitest |

---

## 3. Local setup

```bash
cp .env.example .env.local   # fill; never commit
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm run dev                  # http://localhost:3000
```

First Super Admin: empty `users` collection + `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` → login once → remove bootstrap secrets.

---

## 4. Production setup

1. Complete `PRODUCTION_ENVIRONMENT.md` secrets on the host.  
2. Verify Atlas backup (`BACKUP_AND_RECOVERY.md`).  
3. Follow `PRODUCTION_DEPLOYMENT.md` (do not deploy until external credentials are verified). For Vercel, set Root Directory to the repository root (clear the field or set `.`), not `frontend`.
4. Run `SECURITY_CHECKLIST.md`.

---

## 5. SA workflows

1. Login → Admin → set **active organization** (signed cookie).  
2. Admin: onboard businesses, assign locations, owners, plans, payments, audit.  
3. GMB: connect Google once; Discover locations; fetch reviews per location (explicit).  
4. ORM: business/group dashboards and Reviews — **only the active org**.  
5. Switching organization refreshes Admin lists and clears Reviews client state.

## 6. BA workflows

1. Login → assigned businesses/groups only.  
2. ORM Reviews / dashboards / settings within assignments.  
3. Cannot access Admin APIs or Google connect/disconnect.  
4. No BA fixture may exist in a given non-prod DB — cover via automated tests.

## 7. ORM / Reviews

- Dashboards: `/orm/business/[id]`, `/orm/group/[id]` — group metrics use real `Business.groupId` members only.  
- Reviews: drafts → edit → approve → **manual** publish confirmation.  
- SA Reviews business/group/location filters and inbox queries are **organization-scoped**.  
- Cross-org URL params do not return foreign reviews.

## 8. GMB integration

- Central platform Google connection (SA).  
- Discover → assign one location per business.  
- Sync/publish are explicit; auto-publish kill switch default OFF.  
- Super Admins can load and edit the assigned Google profile from `/orm/business/[id]`; publishing requires confirmation and `ALLOW_LIVE_GBP_PROFILE_WRITES=true`. The editor uses the scoped business/org Google connection and never changes TRONX business data.
- Business Admins retain TRONX-only contact/address/coordinate editing and cannot load or publish Google profile fields. Coordinates and service-area data remain outside the Google editor.
- Google profile writes use complete phone/category groups, structured storefront address, website, title, regular hours, and special hours. A profile fingerprint detects changes since load; a successful PATCH is read back when possible.
- Never disconnect or publish during routine QA unless authorized.

## 9. Known limitations

- Auto-publish enqueue/scheduler not a production default.  
- No payment gateway — manual plan/payment records.  
- No dedicated `/api/health` route.  
- Login and draft rate limits are process-local; multi-instance deployments enforce them independently per instance.
- Live GBP profile/photo writes gated by env flags.  
- Hosting platform (Vercel vs VM) is operator-chosen; see deployment doc.

## 10. Post-deployment smoke tests

See `PRODUCTION_DEPLOYMENT.md`. Minimum: login, org switch, ORM dashboard, org-scoped Reviews, GMB status (read-only).

## 11. Support contacts / ownership

Fill before client handoff:

| Role | Name | Contact |
| --- | --- | --- |
| Application owner | | |
| MongoDB / Atlas admin | | |
| Google Cloud OAuth admin | | |
| On-call | | |
