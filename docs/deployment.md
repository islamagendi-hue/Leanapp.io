# Deployment runbook

Nothing is deployed yet. This is the whole path from an empty account to a
running environment. Steps marked **owner** need the owner's accounts, money or
decisions; everything else runs from the repository. Nothing is deployed or
migrated from a laptop.

## Environments

| | Staging | Production |
| --- | --- | --- |
| Git branch | `staging` | `main` |
| Database | Supabase project 2 (free) | Supabase project 1 |
| Vercel | Preview deployment of the `staging` branch | Production deployment |
| Vercel plan | Hobby is fine (non-commercial development and staging) | **Pro is required before LeanApp is used commercially.** Hobby is for personal, non-commercial use only. |
| Worker schedule | pg_cron every 15 minutes | pg_cron every 5 minutes |
| GitHub environment | `staging` | `production`, with required reviewers |
| Data | Test data only | Customer data |

The two databases, their secrets and their `CRON_SECRET`s are separate. Staging
never reads production data and production never holds test fixtures (the
smoke test writes only to the development data environment of an internal app).

## How a change reaches an environment

```
merge to staging (or main)
  → GitHub Actions "CI" on that commit
  → when CI succeeded: "Deploy" (.github/workflows/deploy.yml), environment staging (or production: waits for a reviewer)
      1. refuses if a secret is missing or the branch moved past the tested commit (before any migration)
      2. npm run db:migrate            (forward-only, each file in its own transaction)
      3. psql -f db/ops/schedule.sql   (pg_cron job, idempotent)
      4. POST the Vercel deploy hook   (builds that branch on Vercel)
      5. npm run smoke                 (waits for the new commit, then checks it)
```

Vercel's automatic Git deploys are turned off for `main` and `staging` in
`apps/platform/vercel.json`, so code is only deployed after its migrations ran.
Deploy never runs for a commit whose CI failed, and has no manual trigger; see
[deploy safety and branch protection](ops/deploy-and-branch-protection.md) for
the gating, the required secrets and the branch protection the owner turns on.
Pull requests still get Vercel previews and CI (lint, typecheck, unit,
integration against Postgres, migrations on an empty database, build, browser
tests).

Migrations must be backward compatible with the code already running (add
columns with defaults or nullable, backfill, tighten later). Rollback: Vercel
instant rollback for code; migrations are forward-only, so a revert is a new
migration.

## Scheduled worker

`/api/internal/process-events` retries privacy deletions, drains events the
per-request `after()` hook missed, runs re-map and growth jobs, housekeeping,
usage notices, attribution postbacks and engagement (audiences, automations,
webhooks). It needs a schedule:

- **Supabase `pg_cron` + `pg_net`** call it (`db/ops/schedule.sql`): every 5
  minutes in production, every 15 in staging. The Bearer secret is kept in
  Supabase Vault and read when the job runs. Both extensions are included in the
  free plan.
- **Vercel Cron** stays at once a day (`vercel.json`) as a safety net. Hobby only
  allows daily jobs; nothing depends on it for the 5-minute cadence.
- No paid one-minute scheduler. Move to one only when measured load shows the
  5-minute cadence is not enough.

## One-time setup (owner)

1. **Supabase.** Create two projects in a region close to users: `leanapp-prod`
   and `leanapp-staging`. The free plan allows two active projects per
   organization; the Growx Era project counts against that limit if it is in the
   same organization (pause it, or create a new organization for LeanApp).
   For each, copy two connection strings: the **transaction pooler** URL (for
   Vercel) and the **session pooler or direct** URL (for migrations).
2. **Vercel.** Import the GitHub repository as one project, **Root Directory
   `apps/platform`**, framework Next.js, install command `npm ci`. Create two
   deploy hooks (Settings → Git → Deploy Hooks): one for `main`, one for
   `staging`. For staging, either turn off Vercel Authentication for the
   `staging` branch domain or create a *Protection Bypass for Automation*
   secret.
3. **Plan terms.** Keep Hobby while LeanApp is non-commercial. Upgrade to Pro
   before the first paying customer or any commercial production use.
4. **DNS** (at the leanapp.io registrar): `app` and `api` CNAME to Vercel and
   add both domains to the project (production). Optional: `staging.leanapp.io`
   assigned to the `staging` branch. Resend's DNS records for the sending
   domain.
5. **Vercel environment variables**, Production and Preview separately (Preview
   holds the staging values):
   - `DATABASE_URL` (transaction pooler URL), `DATABASE_SSL=require`
   - `CRON_SECRET` (`openssl rand -base64 32`, different per environment)
   - `PUBLIC_API_URL`, `PUBLIC_APP_URL` (`https://api.leanapp.io`, `https://app.leanapp.io` in production)
   - `INTEGRATIONS_ENCRYPTION_KEY` (`openssl rand -hex 32`, keep stable)
   - `ATTRIBUTION_IP_HASH_SECRET` (`openssl rand -base64 32`)
   - `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `LeanApp <no-reply@leanapp.io>`)
   - Optional: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` ([billing](billing.md)); `EVENT_RETENTION` stays unset (deletion is off until paid plans are final); `DEMO_ENABLED=1` turns on the public read-only demo (sample data with installs by source and daily ad spend for the paid ones, refreshed by the scheduled worker; an existing demo gets its spend filled in on the next refresh or visit).
   - Monitoring ([ops/monitoring.md](ops/monitoring.md)): `ALERT_WEBHOOK_URL` (Slack/Discord webhook), optionally `SENTRY_DSN`, and `MONITORING_SECRET` for the uptime check of `/api/internal/worker-status`.
6. **GitHub environments** (repository Settings → Environments): create
   `staging` and `production`; on `production` add yourself as a required
   reviewer and restrict it to the `main` branch (leave `staging` unrestricted:
   Deploy runs from `workflow_run`, whose ref is always `main`). In each, add secrets
   `DATABASE_URL` (session pooler or direct URL), `CRON_SECRET` (same value as
   in Vercel), `APP_URL`, `VERCEL_DEPLOY_HOOK_URL` (required for production), and optionally
   `VERCEL_BYPASS` (staging) and `SMOKE_SDK_KEY`; and a variable
   `WORKER_SCHEDULE` = `*/5 * * * *` (production) or `*/15 * * * *` (staging).
7. **First deploy.** Create the `staging` branch from `main` (or merge into
   it); the Deploy workflow runs. Check it, then merge to `main` and approve
   the production run.
8. **Smoke app** (optional, after the first deploy): sign up in each
   environment, create an internal app "LeanApp smoke", and store its
   *development* SDK key as `SMOKE_SDK_KEY` so every deploy sends and checks a
   test event.

## Checking a deploy

The workflow's smoke step prints each check. By hand:

- `GET https://api.leanapp.io/v1/health` → 200, `"status":"ok"`, and `version` = the deployed commit.
- Supabase → Integrations → Cron: `leanapp-process-events` active; its runs succeed. `select status_code, created from net._http_response order by created desc limit 5;` shows 200s.
- Vercel → Logs: `cron.completed` every 5 minutes in production (15 in staging).
- Sign up, create an organization and app, send the test event from the SDK page, see it in the debugger.

## Releasing the SDKs

See [sdk-release](sdk-release.md). Nothing is published automatically.
