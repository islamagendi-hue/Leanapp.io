# Security

Status: controls marked ✓ are built and tested; ○ are planned.

## Authentication

- ✓ Passwords hashed with scrypt (N=2^15, r=8, p=1, 16-byte salt), stored as `scrypt$N$r$p$salt$hash` so the cost can be raised later without invalidating existing hashes and older hashes are upgraded on the next successful sign-in. Minimum length 10. NFKC-normalized.
- ✓ Unknown emails still run a hash against a dummy value, so response time doesn't reveal which emails exist.
- ✓ Sessions: 32-byte random token in an `httpOnly`, `Secure` (production), `SameSite=Lax` cookie `la_session` for 30 days. Only the SHA-256 of the token is stored. Sign-out deletes the row; "sign out everywhere" deletes all of a user's sessions.
- ✓ Throttling: sign-up 10/hour per IP; login 10 per 15 min per email and 50 per 15 min per IP.
- ○ OAuth (Google, Apple) and MFA (TOTP): `user_identities` and the `users.mfa_*` columns are ready, flows are not built.
- ✓ Email verification and password reset use one-time tokens: 32 random bytes, stored only as SHA-256 in `auth_tokens` (no grant to the app role), single use, 24h (verify) or 1h (reset), and a new token invalidates older ones. Links open a page that confirms with a POST, so mail scanners that prefetch links can't consume them.
- ✓ Password reset answers the same whether or not the account exists, is throttled 3/hour per email and 20/hour per IP, signs out every session, marks the email verified and sends a "password changed" email.
- ✓ Changing the password re-checks the current one and signs out every other session. The account page lists active sessions and can sign out the others.
- ✓ Email goes through Resend when `RESEND_API_KEY` and `EMAIL_FROM` are set. Without them, development logs the email; production sends nothing and the UI says so (invitations still show the link to share by hand).

## Authorization

- ✓ Central permission matrix ([RBAC](rbac.md)), checked in `tenantTx` before any tenant query, plus RLS in the database ([multi-tenancy](multi-tenancy.md)).
- ✓ Pages a role can't use render 404.
- ✓ Members can't grant a role above their own or manage someone of a higher rank; the last owner can't be removed.

## Keys

| Key | Format | Stored | Where it may live |
| --- | --- | --- | --- |
| Public SDK key | `la_pk_{dev,stg,live}_…` | clear + SHA-256 | Inside apps. Can only send events to one environment. |
| Secret API key | `la_sk_{dev,stg,live}_…` | SHA-256 + display prefix; shown once | Servers only. The SDK refuses a secret key on any platform other than `backend`. |

- ✓ Rotation creates a new key and keeps the old one valid for a grace period (default 72h, 0–90 days) so app releases can roll out.
- ✓ Revocation is immediate. Keys check expiry, revocation and that the environment, app and organization are active.
- ✓ All key operations are audit-logged.

## Ingestion hardening

- ✓ Body limits (1MB batch, 64KB event, 32KB properties, 255 keys, depth 4) checked before parsing where possible.
- ✓ Per-environment rate limit (default 6,000 events/min) with `429` and `Retry-After`.
- ✓ Timestamps older than 31 days are rejected; future timestamps beyond 10 minutes are replaced with receive time; batch `sent_at` corrects device clock skew.
- ✓ Push tokens are moved out of event context into `push_tokens` after processing so raw tokens don't sit in the event log.
- ✓ CORS open on ingestion only (public keys are meant for clients); management APIs are same-origin, cookie-authenticated.

## Web

- ✓ Security headers: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`. ○ A strict CSP.
- ✓ Server actions are POST-only and origin-checked by Next.js.
- ✓ All SQL is parameterized; there is no string-built SQL with user input.

## Secrets and operations

- ✓ No secrets in Git: configuration via environment variables (`.env.example` documents them, `.env*` is ignored).
- ✓ Third-party credentials are referenced by `integrations.secret_ref` (a secret-manager key), never stored in rows.
- ✓ `/api/internal/process-events` requires `Authorization: Bearer $CRON_SECRET`.
- ✓ Audit log of security-relevant actions (sign-ups, organization and member changes, keys, plan approval and publish, mappings).
- ○ Secret manager integration (Vercel / Doppler / AWS Secrets Manager) once there are third-party credentials to store.
- ○ Dependency and secret scanning in CI, penetration test before the first paying customer.

## Reporting

Security issues: security@leanapp.io (mailbox to be created by the owner).
