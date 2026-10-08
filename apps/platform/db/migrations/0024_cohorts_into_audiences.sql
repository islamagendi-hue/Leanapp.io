-- PR 5: one segmentation layer. Analytics cohorts become audiences.
--
-- Every saved cohort is copied into platform.audiences with the SAME id, so
-- saved reports (config.cohortId) and links (?cohort=<id>) keep working: the
-- analytics cohort filter now reads audiences. Copies start as drafts (reports
-- compute them on demand; activating one starts scheduled membership).
--
-- analytics_cohorts is left as it was (nothing writes to it any more), so the
-- copy can be checked or redone; a later cleanup can drop it.
--
-- Conversion (same people as before):
--   event condition      → event leaf: did, at least minCount times, in the last
--                          N days or between two dates, property filter as `where`
--   user property        → user_property leaf
--   both                 → AND group
--   "is not" (neq)       → "is set" AND "is not": cohorts never matched people
--                          without the property, audiences do, so the copy says so.
--   numeric comparisons  → the value becomes a JSON number.

create or replace function platform.cohort_filters_to_audience(f jsonb) returns jsonb
language sql immutable as $$
  select case
    when f is null or jsonb_typeof(f) <> 'object' then '[]'::jsonb
    when f->>'op' in ('exists', 'not_exists') then jsonb_build_array(jsonb_build_object('property', f->>'name', 'op', f->>'op'))
    when f->>'op' in ('gt', 'gte', 'lt', 'lte') then jsonb_build_array(jsonb_build_object('property', f->>'name', 'op', f->>'op', 'value', (f->>'value')::numeric))
    when f->>'op' = 'neq' then jsonb_build_array(
      jsonb_build_object('property', f->>'name', 'op', 'exists'),
      jsonb_build_object('property', f->>'name', 'op', 'neq', 'value', f->>'value'))
    else jsonb_build_array(jsonb_build_object('property', f->>'name', 'op', f->>'op', 'value', f->>'value'))
  end
$$;

create or replace function platform.cohort_definition_to_audience(d jsonb) returns jsonb
language plpgsql immutable as $$
declare
  ev jsonb := d->'event';
  up jsonb := d->'userProperty';
  parts jsonb := '[]'::jsonb;
  leaf jsonb;
  f jsonb;
begin
  if jsonb_typeof(ev) = 'object' then
    leaf := jsonb_build_object(
      'type', 'event', 'event', ev->>'name', 'did', true, 'countOp', 'gte',
      'count', coalesce((ev->>'minCount')::int, 1),
      'withinDays', case when ev->'range'->>'kind' = 'last' then (ev->'range'->>'days')::int else 30 end,
      'where', platform.cohort_filters_to_audience(ev->'property'));
    if ev->'range'->>'kind' = 'between' then
      leaf := leaf || jsonb_build_object('between', jsonb_build_object('from', ev->'range'->>'from', 'to', ev->'range'->>'to'));
    end if;
    parts := parts || jsonb_build_array(leaf);
  end if;
  if jsonb_typeof(up) = 'object' then
    for f in select * from jsonb_array_elements(platform.cohort_filters_to_audience(up)) loop
      parts := parts || jsonb_build_array(jsonb_build_object('type', 'user_property') || f);
    end loop;
  end if;
  if jsonb_array_length(parts) = 0 then return null; end if;
  if jsonb_array_length(parts) = 1 then return parts->0; end if;
  return jsonb_build_object('type', 'and', 'children', parts);
end
$$;

-- Copies cohorts that aren't audiences yet; returns how many. Safe to run again.
create or replace function platform.copy_cohorts_to_audiences() returns int
language plpgsql as $$
declare n int;
begin
  insert into platform.audiences (id, organization_id, app_id, environment_id, name, description, definition, status, created_by, updated_by, created_at, updated_at)
  select c.id, c.organization_id, c.app_id, c.environment_id,
         case when char_length(c.name) < 2 then c.name || ' cohort' else left(c.name, 80) end,
         c.description, platform.cohort_definition_to_audience(c.definition), 'draft',
         c.created_by, c.created_by, c.created_at, c.updated_at
    from platform.analytics_cohorts c
   where platform.cohort_definition_to_audience(c.definition) is not null
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  return n;
end
$$;

select platform.copy_cohorts_to_audiences();

-- Analysts created cohorts (analytics.write); they now create audiences.
-- Viewers could see cohorts; they now see audiences (read only).
insert into platform.role_permissions (role_id, permission_id) values
  ('analyst', 'audiences.manage'),
  ('viewer', 'audiences.read')
on conflict do nothing;
update platform.roles set description = 'Analytics, funnels, retention, audiences, attribution and users.' where id = 'analyst';
update platform.roles set description = 'Read-only access to analytics, activation, audiences and users.' where id = 'viewer';
update platform.permissions set description = 'View analytics, funnels and retention' where id = 'analytics.read';
update platform.permissions set description = 'Save analytics reports' where id = 'analytics.write';
