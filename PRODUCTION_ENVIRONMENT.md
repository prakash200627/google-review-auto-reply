# TRONX — Production environment checklist

Never commit secret values. This document lists **names only**.

Copy from `.env.example` into the host secret store / platform env UI.

## Required variables

| Variable | Purpose | Required | Where to obtain | Server-only | Integrations |
| --- | --- | --- | --- | --- | --- |
| `MONGODB_URI` | MongoDB connection string | **Yes** | Atlas → Connect → Drivers | Yes | All persistence, transactions |
| `AUTH_SECRET` | HMAC for user + org cookies (≥16 chars; use ≥32) | **Yes** | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` | Yes | Sessions, org switch cookie |
| `APP_URL` | Public origin (no trailing slash) | **Yes** | Your production HTTPS URL | Yes | OAuth redirects, CSRF origin checks |
| `GOOGLE_CLIENT_ID` | Google OAuth client id | **Yes** (GBP) | Google Cloud Console → APIs & Services → Credentials | Yes | GMB OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | **Yes** (GBP) | Same OAuth client | Yes | GMB OAuth |
| `GOOGLE_REDIRECT_URI` | Exact OAuth callback URL | **Yes** (GBP) | Must equal `{APP_URL}/api/auth/google/callback` and be registered in Google Cloud | Yes | GMB OAuth |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored Google tokens (64 hex or 32-byte base64) | **Yes** (GBP) | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | Yes | Token at-rest encryption |

## Strongly recommended

| Variable | Purpose | Required | Where to obtain | Server-only | Integrations |
| --- | --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | AI reply drafts | Required for draft generate | OpenAI dashboard | Yes | Draft API |
| `OPENAI_MODEL` | Chat model id | Optional (default `gpt-4o-mini`) | OpenAI | Yes | Draft API |
| `CLOUDINARY_CLOUD_NAME` | Media uploads | Required for outlet photos | Cloudinary console | Yes | Business media |
| `CLOUDINARY_API_KEY` | Media API key | Same | Cloudinary | Yes | Business media |
| `CLOUDINARY_API_SECRET` | Media API secret | Same | Cloudinary | Yes | Business media |
| `NODE_ENV` | Runtime mode | Set `production` on host | Platform | Yes | Secure cookies, Mongo host filter off |

## Optional / gated

| Variable | Purpose | Required | Notes |
| --- | --- | --- | --- |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | Bootstrap first SA when `users` is empty | Optional | Remove after first login |
| `ALLOW_REMOTE_MONGO` | Dev-only escape hatch | No | Must **not** be needed in production Atlas |
| `ALLOW_LIVE_GBP_PROFILE_WRITES` | Live Google profile push | No | Must stay unset/`false` unless intentionally enabling |
| `AUTO_PUBLISH_GLOBALLY_ENABLED` | Auto-publish kill switch | No | Keep unset/false unless product enables auto-publish |
| `AUTO_PUBLISH_SCHEDULER_SECRET` | Scheduler bearer for process route | No | Required only if running auto-publish worker |
| `ALLOW_MIGRATE_APPLY` | Allows index migration `--apply` | No | Ops only; never leave as `1` on app hosts |
| `AUDIT_PERSIST_FAILURE_ALERT_THRESHOLD` | Audit write failure alert count | Optional (default 5) | Monitoring |

## Insecure defaults — production must not rely on these

| Concern | Behavior |
| --- | --- |
| Missing `AUTH_SECRET` | Session encode/decode **throws** — app will not silently use a weak default |
| Missing `GOOGLE_TOKEN_ENCRYPTION_KEY` | Token encrypt/decrypt **throws** — no plaintext fallback |
| Missing `MONGODB_URI` | `connectToDatabase` **throws** |
| Cookies | `secure: true` when `NODE_ENV=production`; `httpOnly`; `sameSite=lax` |
| Auto-publish | Globally disabled unless explicitly enabled |
| Live GBP profile writes | Off unless `ALLOW_LIVE_GBP_PROFILE_WRITES=true` |
| Bootstrap SA | Only when users collection empty |

## Related configuration (not env)

- Google Cloud OAuth authorized redirect: `{APP_URL}/api/auth/google/callback`
- MongoDB Atlas network access: allow app host / serverless egress IPs
- Replica set: Atlas provides this; required for multi-document transactions (onboarding / assignments)
- CORS: App is same-origin; mutations use Origin/Referer checks via `assertMutationOrigin`

## Verification (names only)

```bash
node scripts/classify-env-readonly.mjs
node scripts/check-mongo-configured.mjs
```

Do not print secret values to logs or tickets.
