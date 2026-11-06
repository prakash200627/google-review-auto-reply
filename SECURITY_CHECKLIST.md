# TRONX — Security checklist

Use before production cutover. Mark each item after verification.

## Authentication and sessions

- [ ] `AUTH_SECRET` is long, unique per environment, stored only in host secrets
- [ ] Session cookie is `httpOnly`, `sameSite=lax`, `secure` in production
- [ ] Org cookie is server-signed (`tronx_org_id`); forged ObjectIds rejected
- [ ] Bootstrap `SUPERADMIN_*` removed or rotated after first SA user exists
- [ ] Login rate limiting exercised (see `loginRateLimit` tests)

## Authorization

- [ ] All `/api/admin/**` routes use `requireSuperAdmin` (BA denied)
- [ ] BA access uses assignment (`businessIds` / `groupIds` / owner) — never client-only ids
- [ ] SA **Reviews** and **ORM dashboards** scoped to active organization
- [ ] Platform-wide Admin GETs remain SA-only on Admin routes (intentional)
- [ ] Cross-org ORM/Reviews URLs return org mismatch / empty scope (not foreign data)

## Organization isolation

- [ ] Org switch via `POST /api/admin/organizations/select` only (SA)
- [ ] Admin location search / unassigned lists org-scoped
- [ ] GMB location pages use `resolveAuthorizedOrgId`
- [ ] Review draft/reply/flag load reviews with `{ orgId }` match

## Input validation and CSRF

- [ ] Mutations call `assertMutationOrigin` (Origin/Referer vs `APP_URL`)
- [ ] ObjectIds validated before Mongo queries
- [ ] JSON bodies size/shape validated on mutating routes
- [ ] No `dangerouslySetInnerHTML` in app components

## Google OAuth

- [ ] PKCE + server-stored OAuth state with TTL
- [ ] Callback binds org from OAuth state — not client-supplied orgId
- [ ] BA cannot start Google OAuth
- [ ] Tokens encrypted at rest (`GOOGLE_TOKEN_ENCRYPTION_KEY`); never sent to browser

## Secrets and logging

- [ ] No secrets in client bundles (`NEXT_PUBLIC_*` unused for secrets)
- [ ] Audit logs omit tokens / passwords
- [ ] `npm audit` reviewed on release commit

## Uploads and media

- [ ] Cloudinary credentials server-only
- [ ] Upload purpose constrained (internal / gbp_candidate); live GBP photo push gated

## Rate limits and abuse

- [ ] Draft generation rate limited per org
- [ ] Auto-publish scheduler requires strong secret when enabled
- [ ] Auto-publish globally off by default

## Dependency and config

- [ ] Node ≥ 20.9
- [ ] Production build uses `NODE_ENV=production`
- [ ] `ALLOW_LIVE_GBP_PROFILE_WRITES` not enabled unless intentionally
- [ ] `ALLOW_MIGRATE_APPLY` not set on app servers

## Residual risks (accepted / track)

| Item | Severity | Notes |
| --- | --- | --- |
| Requests without Origin/Referer skip CSRF origin check | Recommended | Documented for server jobs; protect scheduler secret |
| No dedicated `/api/health` | Optional | Use `/login` liveness |
| SA Admin APIs remain platform-wide | By design | Keep off BA; Reviews/ORM are org-scoped |
