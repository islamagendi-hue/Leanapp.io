-- Management API and tracking-plan editing.
--
-- 1. Secret keys gain read/write scopes for the management API:
--    management:read  app, environment and published tracking plan
--    plan:write       add custom events to a draft tracking plan
--    analytics:read   events report (top events, trend)
--    users:read       end-user profile lookup by user_id
alter table platform.api_keys drop constraint api_keys_scopes_known;
alter table platform.api_keys
  add constraint api_keys_scopes_known
  check (cardinality(scopes) > 0 and scopes <@ array[
    'events:write', 'privacy:read', 'privacy:write',
    'management:read', 'plan:write', 'analytics:read', 'users:read'
  ]::text[]);

-- 2. Plan editing creates draft versions copied from an earlier version; remember which,
--    so the UI can offer "diff against the version this came from".
alter table platform.tracking_plan_versions
  add column based_on_version_id uuid references platform.tracking_plan_versions(id) on delete set null;

-- Events added by hand (dashboard or API) rather than by the generator.
alter table platform.tracking_events
  add column custom boolean not null default false;

