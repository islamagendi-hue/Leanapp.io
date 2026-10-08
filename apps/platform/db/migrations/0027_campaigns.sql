-- 0027: campaigns (PR 10).
-- A campaign is an automation with one message step and a
-- one-time or recurring send to an audience, so it runs on the same engine
-- (runs, guardrails, logs) instead of a second sending model. `kind` keeps
-- campaigns off the Flows list and gives them their own pages.

alter table platform.automations
  add column kind text not null default 'automation' check (kind in ('automation', 'campaign'));

create index automations_environment_kind_idx on platform.automations (environment_id, kind);
