-- 0023: property catalog.
-- The catalog itself is computed: properties observed in each environment's
-- data, joined with the project's tracking plan (src/modules/properties).
-- This table only keeps what people add by hand: a description per property,
-- shared by every environment of the project.
create table platform.property_definitions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  app_id           uuid not null,
  scope            text not null check (scope in ('user', 'event')),
  name             text not null check (name ~ '^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,63}$'),
  description      text not null default '' check (char_length(description) <= 500),
  updated_by       uuid references platform.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  unique (app_id, scope, name),
  foreign key (organization_id, app_id) references platform.apps(organization_id, id) on delete cascade
);

alter table platform.property_definitions enable row level security;
create policy tenant_isolation on platform.property_definitions for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.property_definitions to platform_app;
