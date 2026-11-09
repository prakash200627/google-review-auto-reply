# TRONX — Production deployment

## Supported runtime (from this repository)

| Item | Value |
| --- | --- |
| Framework | Next.js **16.4.x** (App Router, `next build --webpack`) |
| Node.js | **22.x** on Vercel (the package supports **≥ 20.9**) |
| Build | `npm run build` |
| Start | `npm run start` (`next start`) |
| Package manager | npm (`package-lock.json`) |
| Database | MongoDB with **replica set** (Atlas recommended) |
| Hosting shape | Any Node host that runs `next start` (VM, container, PaaS). **Not** a static-only export. |

The Next.js application and `package.json` are at the repository root. There is no `frontend/` directory. The root `vercel.json` selects the Next.js framework; Vercel's **Root Directory** project setting must also point to the repository root (clear the field or set it to `.`).

For Vercel, configure these Project Settings:

| Setting | Value |
| --- | --- |
| Root Directory | Clear the field or set to `.` (repository root; **not** `frontend`) |
| Framework Preset | Next.js |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | Default (leave the override empty) |
| Node.js Version | `22.x` |

Other hosts can use Node 20.9+ and must:

1. Inject production environment variables (see `PRODUCTION_ENVIRONMENT.md`)
2. Reach MongoDB Atlas (network allowlist)
3. Expose HTTPS publicly for `APP_URL`
4. Keep long-running Node process for SSR + Route Handlers

## Pre-flight (blockers if unmet)

- [ ] Production MongoDB URI (replica set) ready; backup verified (`BACKUP_AND_RECOVERY.md`)
- [ ] All **required** secrets set on the host (never from `.env.local` committed)
- [ ] `APP_URL` is the public HTTPS origin
- [ ] Google OAuth redirect registered: `{APP_URL}/api/auth/google/callback`
- [ ] `GOOGLE_TOKEN_ENCRYPTION_KEY` is the **same** key used to encrypt existing tokens (or plan full Google reconnect)
- [ ] `NODE_ENV=production`
- [ ] Local/CI: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` green on the release commit

## Exact deployment steps (generic Node host)

1. **Tag the release** in git (`git tag vX.Y.Z && git push --tags`). Do not deploy uncommitted trees.
2. **Backup** production Mongo (verify snapshot) — see `BACKUP_AND_RECOVERY.md`.
3. On the host (or CI image):

   ```bash
   git fetch --tags
   git checkout vX.Y.Z
   npm ci
   npm run build
   ```

4. Set production environment variables in the host secret manager (names in `PRODUCTION_ENVIRONMENT.md`). Do not copy developer `.env.local`.
5. Start / restart the process:

   ```bash
   npm run start
   # or: node_modules/.bin/next start -p $PORT
   ```

6. Point the reverse proxy / load balancer at the Node port; terminate TLS at the edge.
7. Confirm `APP_URL` matches the public URL users hit.
8. Run post-deploy smoke tests (below).

## Platform notes (if you choose one later)

| Platform | Fit | Notes |
| --- | --- | --- |
| Vercel | Compatible with Next.js | Apply the Project Settings above; set env in project settings; ensure serverless function limits OK for Google API + Mongo; configure Atlas IP access for Vercel egress |
| Railway / Render / Fly.io | Good fit for `next start` | Persistent process; set health check to `/login` or `/` |
| Bare VM (systemd) | Good fit | Use process manager; nginx TLS; firewall Mongo egress only |

**Do not assume** “local build succeeded” equals “host is configured.” OAuth redirect, Atlas IP allowlist, and secrets are external.

## Post-deploy smoke tests

1. `GET /login` loads over HTTPS
2. SA login succeeds
3. Admin → set organization cookie → Admin businesses list matches that org only
4. `/orm` lists org businesses/groups
5. `/orm/reviews` lists only that org; cross-org `?businessId=` shows org mismatch (no foreign reviews)
6. `/gmb` shows connection status (do **not** disconnect)
7. Open one business ORM dashboard metrics
8. Optional: generate a draft on a **non-production** review if OpenAI is configured — do not publish

## Rollback

1. Redeploy previous tag (`npm ci && npm run build && npm run start`).
2. If schema/index change was applied, follow `BACKUP_AND_RECOVERY.md`.
3. Do not rotate `GOOGLE_TOKEN_ENCRYPTION_KEY` during rollback unless tokens were re-encrypted.

## Health

There is no dedicated `/api/health` route in this codebase. Use:

- Process liveness: HTTP 200 on `/login` or `/`
- Dependency: Atlas metrics + application error logs

Login and draft-generation rate limits use in-memory counters per Node process. On Vercel or another multi-instance/serverless deployment, instances do not share counters, so the effective limit is per instance; use a shared rate-limit store if a deployment-wide limit is required.
