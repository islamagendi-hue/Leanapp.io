-- 0042: Microsoft Clarity metrics imported through Clarity's Data Export API
-- (docs/clarity-integration.md).
--
-- The connection (encrypted API token, project id) and the import capability
-- ("clarity_metrics_import") reuse integration_connections and
-- integration_capabilities from 0035; import runs reuse integration_sync_runs,
-- whose `requests` column also counts against Clarity's 10 requests per
-- project per day.
--
-- Clarity's API returns aggregates over the last 24, 48 or 72 hours, not per
-- calendar day. Each import is one snapshot: `snapshot_date` is the UTC day it
-- ran, `period_end` when it ran, and the data covers `num_of_days` × 24 hours
-- before that. Values are the numeric fields as Clarity names them (jsonb),
-- because Microsoft documents only part of the response.
--
-- Additive only: one new table.

create table platform.clarity_insights (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  environment_id   uuid not null,
  connection_id    uuid not null,
  snapshot_date    date not null,
  num_of_days      smallint not null check (num_of_days between 1 and 3),
  period_end       timestamptz not null,
  dimension        text not null check (dimension in ('URL', 'Device', 'Source')),
  dimension_value  text not null default '' check (char_length(dimension_value) <= 500),
  metric           text not null check (char_length(metric) between 1 and 100),
  metric_values    jsonb not null default '{}',
  imported_at      timestamptz not null default now(),
  unique (connection_id, snapshot_date, dimension, dimension_value, metric),
  foreign key (organization_id, connection_id) references platform.integration_connections(organization_id, id) on delete cascade
);
create index clarity_insights_env_idx on platform.clarity_insights (environment_id, snapshot_date desc);

alter table platform.clarity_insights enable row level security;
create policy tenant_isolation on platform.clarity_insights for all to platform_app
  using (organization_id = platform.current_org_id())
  with check (organization_id = platform.current_org_id());
grant select, insert, update, delete on platform.clarity_insights to platform_app;
