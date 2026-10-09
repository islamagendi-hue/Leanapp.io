# Backup and restore

How the LeanApp database is backed up, how a restore is rehearsed, and how a
restore is proven correct. Production is not provisioned yet; everything here
must be in place, and one restore drill passed, before customer data lands.

Statements taken from the Supabase docs (read 2026-10-09 through the Supabase
docs search) are marked **[Supabase docs]**. Anything else about Supabase plans
and prices is marked **[verify]**: check it in the Supabase docs or dashboard
before relying on it, because plans change.

## Current state

| Item | State | How known |
| --- | --- | --- |
| Staging project | `leanapp-staging`, ref `stpnogsoeaofxlnighnt`, eu-central-1, Postgres 17, ACTIVE_HEALTHY | Supabase API (read only) |
| Staging organization plan | "Lean App" organization, **Free** | Supabase API (read only) |
| Production project | Does not exist yet | Supabase API: the organization has no other project |
| Backups of staging | **None accessible.** Free plan projects get no dashboard backups **[Supabase docs]** | — |
| PITR | Not available on Free **[Supabase docs]** | — |
| Repository backup tooling | None before this document (no notes in `docs/`, `db/`, `deploy.yml`) | Repository search |

Staging holds test data only, so no backup on staging is acceptable. Production
is not.

## Required production configuration

What Supabase offers **[Supabase docs]**:

- **Daily backups**: automatic on Pro, Team and Enterprise. Retention: Pro 7
  days, Team 14, Enterprise 30. Projects on Postgres 15.8.1.079+ use physical
  backups.
- **Point-in-Time Recovery (PITR)**: an add-on for Pro, Team and Enterprise;
  needs at least the **Small** compute add-on. WAL is archived every 2 minutes
  (sooner under load), so worst-case RPO is **2 minutes**. Retention 7, 14 or 28
  days (about $100, $200, $400 per month, **[verify]** current prices). With PITR
  on, daily backups stop (PITR replaces them).
- **Restore to a new project** (beta): paid plans with physical backups; creates
  a separate project from a chosen daily backup or PITR point, same region. It
  copies schema, data, roles, grants and `auth` users; it does **not** copy
  Storage objects, Edge Functions, API keys or auth settings. A project created
  this way cannot itself be cloned. Extensions that act externally (`pg_cron`,
  `pg_net`) must be disabled in the copy.
- **In-place restore** (daily backup or PITR) makes the project unavailable for
  the duration and overwrites it. Use it only for a real incident, never for a
  drill.
- Daily backups do not keep passwords of custom roles; reset them after a restore.
- Deleting a project deletes its backups.
- Free plan: no downloadable backups; Supabase recommends regular
  `supabase db dump` exports kept off-site.

Required for LeanApp production:

1. Production project in its **own paid organization** (Pro or higher), not
   the Growx Era organization and not on Free. **Owner, costs money.**
2. **PITR, 7-day retention, plus Small compute** before the first paying
   customer. Customer events arrive continuously; a daily backup can lose up to
   24 hours of ingestion, PITR at most ~2 minutes. **Owner, costs money.**
   Until PITR is on, Pro's daily backups (7 days) are the minimum acceptable.
3. **Off-site logical dump** at least weekly (and before every risky migration),
   kept outside Supabase, so a deleted project or organization is recoverable.
   Encrypted, in storage the owner controls, retention 30 days or more.
4. **Restore drill** (below) passed once before launch and then every quarter,
   and after any change to backup settings.
5. Supabase account MFA and at least two organization owners, so backups stay
   reachable if one account is lost **[Supabase docs, production checklist]**.

Targets: RPO 2 minutes (PITR) / 24 hours (daily only); RTO under 1 hour for a
database under 10 GB **[verify]** by timing the drill.

## Restore drill: into a separate scratch project

Never restore over production or staging to test. Always restore into a new,
separate scratch project, verify it, then delete it.

### Route A: Supabase "Restore to a new project" (paid plan; preferred)

1. **Owner**: production project → Database → Backups → *Restore to a New
   Project*. Pick a daily backup, or with PITR a timestamp. Write down the
   restore point as UTC (`cutoff`). Review the cost shown; confirm.
2. Record the start time and the time the new project becomes healthy
   (restore duration).
3. **Immediately in the scratch project** (SQL editor), stop the copied
   scheduler so it does not call the production worker with the production
   secret:
   ```sql
   select cron.unschedule(jobid) from cron.job where jobname = 'leanapp-process-events';
   delete from vault.secrets where name in ('leanapp_cron_secret', 'leanapp_protection_bypass');
   ```
   Then disable `pg_cron` and `pg_net` in Database → Extensions.
4. The scratch project contains customer data. Do not connect any Vercel
   deployment to it; share its credentials with no one; delete it after the drill.
5. Run the verification (below) against the scratch project and against
   production with the same `cutoff`, diff the outputs.

### Route B: pg_dump / pg_restore (works on any plan; the only route on Free)

Use a Postgres 17 client (`pg_dump --version` must be ≥ the server's major;
Supabase is on 17) or `supabase db dump`. Use the **session pooler or direct**
connection, not the transaction pooler.

```bash
# 1. Dump the application schema from the source (read-only on the source).
pg_dump "$SOURCE_URL" -Fc --no-owner --schema=platform -f platform.dump
#    Off-site copy: encrypt before upload, e.g. age -r <recipient> platform.dump > platform.dump.age

# 2. Prepare the scratch target (a new Supabase project, or a local database).
#    Role and extension the dump references:
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'platform_app') then
    create role platform_app nologin noinherit nobypassrls;
  end if;
end $$;
do $$ begin execute format('grant platform_app to %I', current_user); end $$;
SQL

# 3. Restore and time it.
time pg_restore --no-owner --exit-on-error -d "$SCRATCH_URL" platform.dump
```

Notes for route B:
- `--schema=platform` dumps LeanApp's data and its migration history
  (`platform.schema_migrations`), not Supabase's own schemas (`auth`,
  `storage`, `cron`, `vault`). LeanApp keeps its users in `platform.users`, so
  that is complete for the app. The scheduler is re-created by
  `db/ops/schedule.sql`; do **not** run it against a scratch copy.
- A dump taken from a live database is consistent as of its start time (one
  snapshot). Use that time as `cutoff`.
- After restoring for real (not a drill), run `npm run db:migrate`: it must say
  "up to date".

Tested locally on 2026-10-09: a migrated database with sample data, dumped and
restored with route B into a fresh database; `verify-restore.sql` outputs were
identical (`diff` empty). After deleting one event and rewinding the events
identity sequence in the copy, the diff showed `events|count`, `events|sum_id`,
the affected day, `rows|events` and `integrity|events_identity_behind|1`.

## Verification: `apps/platform/db/ops/verify-restore.sql`

Read only: one `READ ONLY` repeatable-read transaction, ended with `rollback`.
Safe to run on production. Output is `section|key|value` lines in a fixed order.

| Section | Checks |
| --- | --- |
| `migrations` | count and latest file in `platform.schema_migrations` |
| `organizations` [as of cutoff] | count, count by status, md5 fingerprint of all ids |
| `users` [as of cutoff] | count, md5 fingerprint of all ids |
| `events` [as of cutoff] | count, min/max/sum of `id`, `max(received_at)`, unprocessed count, count per UTC day for the last 7 days of data |
| `integrity` (all must be 0) | duplicate `lower(email)`, org `slug`, `(environment_id, event_id)`, event `id`; orphan members, apps, environments, events (by environment and by organization), SDK keys; organizations without members; constraints not validated; events identity sequence behind `max(id)` |
| `structure` | number of tables, indexes, constraints, RLS-enabled tables, policies; `platform_app` role present; its grant count |
| `rows` [whole table] | exact row count of every `platform` table |

`cutoff` filters by `created_at` / `received_at`, so a source that kept
receiving data after the restore point still matches. The `rows` section and
the integrity counts look at whole tables; they match only when nothing was
written after the cutoff, so differences there are expected on a live source and
must be explained (newer rows only).

### Compare source and restore

```bash
CUTOFF='2026-10-09 12:00:00+00'   # the restore point, UTC
for side in source restore; do
  url=$([ $side = source ] && echo "$SOURCE_URL" || echo "$SCRATCH_URL")
  psql "$url" -X -At -F '|' -v ON_ERROR_STOP=1 -v cutoff="$CUTOFF" \
       -f apps/platform/db/ops/verify-restore.sql > verify-$side.txt
done
diff verify-source.txt verify-restore.txt && echo "restore matches"
grep '^integrity|' verify-restore.txt | grep -v '|0$'   # must print nothing
```

Pass when: the diff is empty, or differs only in `rows|…` lines for tables
written after the cutoff (and for `[as of cutoff]` lines only because of rows
deleted on the source after the cutoff, such as privacy deletions); and every
`integrity` line on the restore is 0.

Then a functional check on the scratch copy, only if it is wired to a local app
(never a Vercel deployment): sign in as a known test user and open one
organization's event debugger.

## Evidence required for each drill

Kept with the Phase 0 / ops ticket:

1. Restore point (`cutoff`, UTC) and route (A or B), backup id or PITR time.
2. Start and finish times, and the **restore duration**; for route B, the dump
   duration and dump size too.
3. Screenshot of the Supabase Backups / PITR page showing retention and the
   earliest recovery point (route A), or the dump file listing (route B).
4. `verify-source.txt`, `verify-restore.txt` and the `diff` output (they contain
   counts and hashes only, no customer data).
5. Proof the scratch copy's scheduler was stopped (`select count(*) from
   cron.job` = 0) and, at the end, that the scratch project was deleted.
6. Name of the person who ran it and anything that went wrong.

## Automated vs owner actions

| Can be automated (repository, CI) | Owner only |
| --- | --- |
| `verify-restore.sql` and the diff procedure (done) | Upgrade the production organization to Pro or higher (money) |
| A scheduled GitHub Actions job that runs `pg_dump` with the `production` environment's `DATABASE_URL` and uploads an encrypted dump to owner-provided storage (needs a bucket and key from the owner; not built yet) | Enable PITR (7 days) and Small compute (money) |
| Running route B into a local or CI Postgres and the verification, for drills on staging-sized data | Route A "Restore to a new project" (dashboard, paid, creates a billed project) and deleting it afterwards |
| Pre-migration dump step in `deploy.yml` (proposal; not built) | Supabase account MFA, second organization owner |
| | Choosing where off-site dumps live and holding the encryption key |
| | Signing off each drill's evidence |
