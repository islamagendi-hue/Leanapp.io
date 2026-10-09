-- Restore verification for the LeanApp platform schema. READ ONLY.
--
-- Run the same file on the source database and on the restored copy, then diff
-- the two outputs (docs/ops/backup-restore.md, "Compare source and restore"):
--
--   psql "$URL" -X -At -F '|' -v ON_ERROR_STOP=1 -v cutoff='2026-10-09 12:00:00+00' \
--        -f db/ops/verify-restore.sql > verify-<source|restore>.txt
--
-- `cutoff` (optional, default 'infinity') is the restore point. Sections marked
-- [as of cutoff] only count rows created at or before it, so a source that kept
-- receiving events after the restore point still compares equal. Sections marked
-- [whole table] must match only when the source was quiet (or for a pg_dump of
-- a stopped source). Rows deleted on the source after the cutoff (privacy
-- deletions, retention) are the one legitimate cause of a [as of cutoff] diff.
--
-- Every line is `section|key|value`, ordered, so `diff` shows exactly what moved.
-- Integrity sections must print 0 on both sides. Nothing here writes: the whole
-- run is one READ ONLY transaction (one snapshot), ended with a rollback.

\set QUIET on
\if :{?cutoff}
\else
  \set cutoff 'infinity'
\endif

begin transaction isolation level repeatable read read only;
set local statement_timeout = '10min';

-- ── 1. Schema version ───────────────────────────────────────────────────────
select 'migrations', 'count', count(*)::text from platform.schema_migrations;
select 'migrations', 'latest', coalesce(max(name), '(none)') from platform.schema_migrations;

-- ── 2. Core tables [as of cutoff] ─────────────────────────────────────────────
select 'organizations', 'count', count(*)::text
  from platform.organizations where created_at <= :'cutoff'::timestamptz;
select 'organizations', 'by_status:' || status, count(*)::text
  from platform.organizations where created_at <= :'cutoff'::timestamptz group by status order by 2;
select 'organizations', 'id_fingerprint', md5(coalesce(string_agg(id::text, ',' order by id), ''))
  from platform.organizations where created_at <= :'cutoff'::timestamptz;

select 'users', 'count', count(*)::text
  from platform.users where created_at <= :'cutoff'::timestamptz;
select 'users', 'id_fingerprint', md5(coalesce(string_agg(id::text, ',' order by id), ''))
  from platform.users where created_at <= :'cutoff'::timestamptz;

select 'events', 'count', count(*)::text
  from platform.events where received_at <= :'cutoff'::timestamptz;
select 'events', 'min_id', coalesce(min(id)::text, '-')
  from platform.events where received_at <= :'cutoff'::timestamptz;
select 'events', 'max_id', coalesce(max(id)::text, '-')
  from platform.events where received_at <= :'cutoff'::timestamptz;
select 'events', 'sum_id', coalesce(sum(id)::text, '0')
  from platform.events where received_at <= :'cutoff'::timestamptz;
select 'events', 'max_received_at', coalesce(max(received_at)::text, '-')
  from platform.events where received_at <= :'cutoff'::timestamptz;
select 'events', 'unprocessed', count(*)::text
  from platform.events where received_at <= :'cutoff'::timestamptz and processed_at is null;
-- Per UTC day for the 7 days ending at the newest event at or before the cutoff
-- (anchored to the data, not now(), so runs at different times compare equal).
with last as (select max(received_at) as t from platform.events where received_at <= :'cutoff'::timestamptz)
select 'events', 'day:' || to_char(date_trunc('day', ev.received_at at time zone 'UTC'), 'YYYY-MM-DD'), count(*)::text
  from platform.events ev, last
 where ev.received_at <= last.t
   and ev.received_at > last.t - interval '7 days'
 group by 2 order by 2;

-- ── 3. Integrity: every value must be 0 ─────────────────────────────────────
-- Duplicates that unique indexes forbid (catches a data-only restore without indexes).
select 'integrity', 'dup_user_email', count(*)::text
  from (select lower(email) from platform.users group by 1 having count(*) > 1) d;
select 'integrity', 'dup_org_slug', count(*)::text
  from (select slug from platform.organizations group by 1 having count(*) > 1) d;
select 'integrity', 'dup_event_env_event_id', count(*)::text
  from (select environment_id, event_id from platform.events group by 1, 2 having count(*) > 1) d;
select 'integrity', 'dup_event_pk', count(*)::text
  from (select id from platform.events group by 1 having count(*) > 1) d;

-- Orphans that foreign keys forbid (catches restores run with triggers/FKs disabled).
select 'integrity', 'orphan_member_org', count(*)::text
  from platform.organization_members m
 where not exists (select 1 from platform.organizations o where o.id = m.organization_id);
select 'integrity', 'orphan_member_user', count(*)::text
  from platform.organization_members m
 where not exists (select 1 from platform.users u where u.id = m.user_id);
select 'integrity', 'orphan_app_org', count(*)::text
  from platform.apps a
 where not exists (select 1 from platform.organizations o where o.id = a.organization_id);
select 'integrity', 'orphan_env_app', count(*)::text
  from platform.environments e
 where not exists (select 1 from platform.apps a where a.id = e.app_id and a.organization_id = e.organization_id);
select 'integrity', 'orphan_event_env', count(*)::text
  from platform.events ev
 where not exists (
   select 1 from platform.environments e
    where e.id = ev.environment_id and e.app_id = ev.app_id and e.organization_id = ev.organization_id);
select 'integrity', 'orphan_event_org', count(*)::text
  from platform.events ev
 where not exists (select 1 from platform.organizations o where o.id = ev.organization_id);
select 'integrity', 'orphan_sdk_key_env', count(*)::text
  from platform.sdk_keys k
 where not exists (select 1 from platform.environments e where e.id = k.environment_id);
select 'integrity', 'org_without_members', count(*)::text
  from platform.organizations o
 where o.status <> 'deleted' and o.created_at <= :'cutoff'::timestamptz
   and not exists (select 1 from platform.organization_members m where m.organization_id = o.id);

-- Constraints present but not validated (NOT VALID after a restore).
select 'integrity', 'unvalidated_constraints', count(*)::text
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace
 where n.nspname = 'platform' and not c.convalidated;
-- Identity sequence behind the data: the next insert would collide.
select 'integrity', 'events_identity_behind', count(*)::text
  from (select pg_sequence_last_value(pg_get_serial_sequence('platform.events', 'id')) as last) s
 where coalesce(s.last, 0) < coalesce((select max(id) from platform.events), 0);

-- ── 4. Structure (must match exactly) ───────────────────────────────────────
select 'structure', 'tables', count(*)::text
  from pg_tables where schemaname = 'platform';
select 'structure', 'indexes', count(*)::text
  from pg_indexes where schemaname = 'platform';
select 'structure', 'constraints', count(*)::text
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'platform';
select 'structure', 'rls_tables', count(*)::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'platform' and c.relkind = 'r' and c.relrowsecurity;
select 'structure', 'policies', count(*)::text
  from pg_policies where schemaname = 'platform';
select 'structure', 'role_platform_app', count(*)::text
  from pg_roles where rolname = 'platform_app';
select 'structure', 'app_role_grants', count(*)::text
  from information_schema.role_table_grants where grantee = 'platform_app' and table_schema = 'platform';

-- ── 5. Every platform table [whole table] ───────────────────────────────────
-- Exact counts via query_to_xml (still read only). Matches only for a quiet source.
select 'rows', t.tablename,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.schemaname, t.tablename), false, true, '')))[1]::text
  from pg_tables t
 where t.schemaname = 'platform'
 order by t.tablename;

rollback;
