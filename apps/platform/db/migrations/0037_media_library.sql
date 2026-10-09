-- 0037: shared media library (src/modules/media, docs/media.md).
-- An asset belongs to one app of one organization and is shared by all its
-- environments. The file itself lives in a storage driver (MEDIA_STORAGE_DRIVER):
-- `postgres` keeps the bytes in platform.media_objects below, `s3` in an
-- S3-compatible bucket; storage_driver records which, so switching drivers
-- keeps old files readable.
--
-- Deleting is soft (deleted_at) and refused while a usage row points at the
-- asset. A scheduled job later removes the stored object of deleted assets
-- that nothing references (purged_at); the row stays for the audit trail.
--
-- public_token names the file at the durable public URL /m/<token>.<ext>
-- (WhatsApp, push and email providers fetch media themselves and need a
-- stable URL, never a short-lived signed one). It only serves while
-- public_access is true and the asset isn't deleted.
create table platform.media_assets (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  name             text not null check (char_length(name) between 1 and 200),
  folder           text check (folder is null or (char_length(folder) between 1 and 100 and folder !~ '(^/|/$|//)')),
  tags             text[] not null default '{}' check (cardinality(tags) <= 20),
  mime_type        text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/3gpp', 'application/pdf')),
  kind             text not null check (kind in ('image', 'gif', 'video', 'document')),
  size_bytes       bigint not null check (size_bytes > 0),
  width            int check (width is null or width between 1 and 8192),
  height           int check (height is null or height between 1 and 8192),
  animated         boolean not null default false,
  checksum_sha256  text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  storage_driver   text not null check (storage_driver in ('postgres', 's3')),
  storage_key      text not null unique,
  public_token     text not null unique check (public_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  public_access    boolean not null default false,
  created_by       uuid references platform.users(id) on delete set null,
  updated_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  deleted_by       uuid references platform.users(id) on delete set null,
  purged_at        timestamptz,
  unique (organization_id, id),
  check (purged_at is null or deleted_at is not null),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);
create index media_assets_app_created_idx on platform.media_assets (app_id, created_at desc) where deleted_at is null;
create index media_assets_app_checksum_idx on platform.media_assets (app_id, checksum_sha256) where deleted_at is null;
create index media_assets_purge_idx on platform.media_assets (deleted_at) where deleted_at is not null and purged_at is null;
create index media_assets_tags_idx on platform.media_assets using gin (tags);

create trigger media_assets_touch before update on platform.media_assets for each row execute function platform.touch_updated_at();
alter table platform.media_assets enable row level security;
create policy tenant_isolation on platform.media_assets for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update on platform.media_assets to platform_app;

-- Where an asset is used. A row blocks deleting the asset; the purge job also
-- skips assets whose id or public token appears in an automation definition or
-- an email template, so a reference saved without a row is still safe.
-- ref_type: automation (flows and campaigns), email_template, whatsapp_template, other.
create table platform.media_usages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  asset_id         uuid not null,
  ref_type         text not null check (ref_type in ('automation', 'email_template', 'whatsapp_template', 'other')),
  ref_id           text not null check (char_length(ref_id) between 1 and 200),
  channel          text check (channel in ('push', 'web_push', 'in_app', 'email', 'whatsapp', 'sms')),
  created_by       uuid references platform.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (asset_id, ref_type, ref_id),
  foreign key (organization_id, asset_id) references platform.media_assets(organization_id, id),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);
create index media_usages_ref_idx on platform.media_usages (organization_id, ref_type, ref_id);

alter table platform.media_usages enable row level security;
create policy tenant_isolation on platform.media_usages for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.media_usages to platform_app;

-- File bytes for the postgres driver. Only trusted server code reads it (as the
-- owning role, after the asset row was authorized), so platform_app gets no grant.
create table platform.media_objects (
  storage_key      text primary key,
  organization_id  uuid not null references platform.organizations(id) on delete cascade,
  content_type     text not null,
  bytes            bytea not null,
  created_at       timestamptz not null default now()
);
alter table platform.media_objects enable row level security;

-- Permissions (src/modules/rbac/permissions.ts).
insert into platform.permissions (id, description) values
  ('media.read', 'View the media library'),
  ('media.manage', 'Upload, replace, publish and delete media')
on conflict (id) do update set description = excluded.description;
insert into platform.role_permissions (role_id, permission_id) values
  ('owner', 'media.read'), ('owner', 'media.manage'),
  ('admin', 'media.read'), ('admin', 'media.manage'),
  ('developer', 'media.read'), ('developer', 'media.manage'),
  ('marketer', 'media.read'), ('marketer', 'media.manage')
on conflict do nothing;
