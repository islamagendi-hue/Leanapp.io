# Deployment

Nothing is deployed yet. These are the steps; the ones marked **owner** need the owner's accounts or decisions.

## One-time setup

1. **owner:** choose the production database: a new Supabase project (recommended) or another managed Postgres.
2. **owner:** create a Vercel project from the GitHub repo with **Root Directory = `apps/platform`**. Framework preset: Next.js. Install command `npm ci`.
3. Set environment variables in Vercel (Production and Preview separately):
   - `DATABASE_URL` (pooler URL, transaction mode), `DATABASE_SSL=require`
   - `CRON_SECRET` (random, 32+ chars: `openssl rand -base64 32`)
   - `PUBLIC_API_URL=https://api.leanapp.io`, `PUBLIC_APP_URL=https://app.leanapp.io`
4. Apply migrations from CI or a trusted machine with the production `DATABASE_URL`: `cd apps/platform && npm run db:migrate`. Migrations are idempotent per file and recorded in `platform.schema_migrations`.
5. **owner:** DNS for leanapp.io: `app` and `api` CNAME to Vercel, apex per Vercel's instructions. Add the domains in the Vercel project.
6. Vercel Cron is declared in `apps/platform/vercel.json` (every 5 minutes). On the Hobby plan Vercel only allows daily cron jobs; processing still happens after every ingestion request via `after()`, so a daily safety net is acceptable at low volume.

## Release flow

- Every PR: CI (lint, typecheck, unit, integration against Postgres, build) and a Vercel preview.
- Merge to `main` → Vercel production deploy. No deploys from laptops.
- Database migrations run **before** the deploy that needs them, and must be backward compatible with the running code (add columns nullable, backfill, then tighten in a later migration).
- Rollback: Vercel instant rollback for code. Migrations are forward-only; write a new migration to revert.

## After the first deploy

- `GET https://api.leanapp.io/v1/health` returns `{"status":"ok"}`.
- Sign up, create an organization and app, send the test event from the SDK page, see it in the debugger.
- Check the cron run in Vercel's logs.
