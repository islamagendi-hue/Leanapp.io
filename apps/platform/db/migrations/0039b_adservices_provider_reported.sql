-- 0039b: Apple Search Ads (AdServices) answers count as provider-reported attribution
-- (docs/attribution.md "Apple Search Ads (AdServices)").
--
-- Additive: two check constraints are widened. Runs after 0039 and before 0040 by
-- name; on a database that already has 0040 it is applied on the next migrate run
-- (it only depends on 0039).
--
--   attribution_events.match_type 'provider_reported': an install Apple's AdServices
--     API attributed to an Apple Search Ads campaign (match_key 'adservices'). Only an
--     install with nothing matched (match_type 'organic') is upgraded, once, keeping
--     what it was in evidence.upgraded_from; a LeanApp click match is never overridden.
--   attribution_conversion_credits.reason 'provider_reported': conversions re-credited
--     because such an answer arrived after them.

alter table platform.attribution_events drop constraint if exists attribution_events_match_type_check;
alter table platform.attribution_events
  add constraint attribution_events_match_type_check check (match_type in ('deterministic', 'reported', 'probabilistic', 'organic', 'provider_reported'));

alter table platform.attribution_conversion_credits drop constraint if exists attribution_conversion_credits_reason_check;
alter table platform.attribution_conversion_credits
  add constraint attribution_conversion_credits_reason_check check (reason in ('initial', 'late_touch', 'provider_reported'));
