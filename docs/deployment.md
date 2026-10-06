# Deployment

Nothing is deployed yet. These are the steps; the ones marked **owner** need the owner's accounts or decisions.

## One-time setup

1. **owner:** choose the production database: a new Supabase project (recommended) or another managed Postgres.
2. **owner:** create a Vercel project from the GitHub repo with **Root Directory = `apps/platform`**. Framework preset: Next.js. Install command `npm ci`.
3. Set environment variables in Vercel (Production and Preview separately):
   - `DATABASE_URL` (pooler URL, transaction mode), `DATABASE_SSL=require`
   - `CRON_SECRET` (random, 32+ chars: `openssl rand -base64 32`)
   - `PUBLIC_API_URL=https://api.leanapp.io`, `PUBLIC_APP_URL=https://app.leanapp.io`
   - `EVENT_RETENTION=enforce` only once you have decided to delete customer events past their plan's retention (free plan: 30 days). Leave it unset to report instead of delete.
   - `INTEGRATIONS_ENCRYPTION_KEY` (`openssl rand -hex 32`, 32 bytes as hex or base64): encrypts customer credentials (ad-network postbacks, push, WhatsApp and email providers) and webhook signing secrets. Without it they can't be saved (the UI says so). Keep it stable: rotating it makes stored credentials unreadable, so customers would have to re-enter them and rotate webhook secrets.
   - `ATTRIBUTION_IP_HASH_SECRET` (`openssl rand -base64 32`): keys the hash of visitor IPs used by opt-in probabilistic attribution. Without it no IP hashes are stored.
   - `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `LeanApp <no-reply@leanapp.io>`, on a domain verified in Resend). Without them production sends no email: verification and password reset won't arrive, and invitations fall back to a link the inviter shares.
   - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (**owner**: Stripe account) to connect payments; also set `plans.stripe_price_id` and register the webhook, see [billing](billing.md). Without them the billing page says payments aren't connected and upgrades are disabled.
4. Apply migrations from CI or a trusted machine with the production `DATABASE_URL`: `cd apps/platform && npm run db:migrate`. Migrations are idempotent per file and recorded in `platform.schema_migrations`.
5. **owner:** DNS for leanapp.io: `app` and `api` CNAME to Vercel, apex per Vercel's instructions. Add the domains in the Vercel project.
6. Vercel Cron is declared in `apps/platform/vercel.json` (every 5 minutes). On the Hobby plan Vercel only allows daily cron jobs; processing still happens after every ingestion request via `after()`, so a daily safety net is acceptable at low volume. Audiences, automations and webhook deliveries run only in the cron job, so they need the 5-minute schedule (Vercel Pro or an external scheduler calling the endpoint with `CRON_SECRET`).

## Release flow

- Every PR: CI (lint, typecheck, unit, integration against Postgres, build) and a Vercel preview.
- Merge to `main` → Vercel production deploy. No deploys from laptops.
- Database migrations run **before** the deploy that needs them, and must be backward compatible with the running code (add columns nullable, backfill, then tighten in a later migration).
- Rollback: Vercel instant rollback for code. Migrations are forward-only; write a new migration to revert.

## After the first deploy

- `GET https://api.leanapp.io/v1/health` returns `{"status":"ok"}`.
- Sign up, create an organization and app, send the test event from the SDK page, see it in the debugger.
- Check the cron run in Vercel's logs.
