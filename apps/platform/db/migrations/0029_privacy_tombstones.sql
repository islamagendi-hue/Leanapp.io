-- 0029: privacy tombstones.
-- A completed deletion leaves one row per identifier it deleted (the user_id,
-- and each install whose anonymous activity it deleted), so events still in an
-- SDK's offline queue or sent later by a backend don't re-create the person.
-- Ingestion drops them with reason `subject_deleted` (modules/ingestion).
--
-- The identifier itself is not kept: subject_hash is sha256 of
-- "privacy-tombstone:v1:<environment_id>:<kind>:<id>" (modules/privacy/tombstones),
-- so the same id gives unrelated hashes in other environments. Matching is an
-- exact lookup on (environment_id, kind, subject_hash): the primary key.
-- Tombstones never expire; a person who comes back needs a new user_id.
create table platform.privacy_tombstones (
  organization_id     uuid not null,
  environment_id      uuid not null,
  kind                text not null check (kind in ('user_id', 'anonymous_id')),
  subject_hash        text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  privacy_request_id  uuid references platform.privacy_requests(id) on delete set null,
  deleted_at          timestamptz not null default now(),
  primary key (environment_id, kind, subject_hash),
  foreign key (organization_id, environment_id) references platform.environments(organization_id, id) on delete cascade
);

alter table platform.privacy_tombstones enable row level security;
create policy tenant_isolation on platform.privacy_tombstones for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.privacy_tombstones to platform_app;
