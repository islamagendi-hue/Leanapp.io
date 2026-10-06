-- Secret API key scopes are now enforced: events:write for ingestion,
-- privacy:read for exports, privacy:write for deletions. Existing keys keep
-- what they have (events:write by default).
alter table platform.api_keys
  add constraint api_keys_scopes_known
  check (cardinality(scopes) > 0 and scopes <@ array['events:write', 'privacy:read', 'privacy:write']::text[]);

-- Installs a deletion left alone because another user is linked to them too.
alter table platform.data_deletion_jobs
  add column skipped_anonymous_ids text[] not null default '{}';

-- Job errors are shown in the dashboard; raw database messages now go to the logs only.
update platform.data_deletion_jobs set error = 'internal_error' where error is not null;
