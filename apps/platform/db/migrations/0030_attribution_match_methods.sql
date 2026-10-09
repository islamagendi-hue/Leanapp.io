-- 0030: Honest attribution match methods (docs/attribution.md "Matching").
--
-- `deterministic` now means only what LeanApp verified itself: the install
-- carried a click id that matches a click LeanApp's own tracking link recorded
-- (LeanApp click id from the Play install referrer, a deep link or the
-- context; or an ad-network click id that LeanApp's link recorded on the
-- click). An ad-network click id or utm_* parameters that only the install's
-- own context reports, with no click of ours behind them, are `reported`.
-- Probabilistic and organic are unchanged.

alter table platform.attribution_events drop constraint if exists attribution_events_match_type_check;
alter table platform.attribution_events
  add constraint attribution_events_match_type_check check (match_type in ('deterministic', 'reported', 'probabilistic', 'organic'));

-- Relabel history: a "deterministic" attribution whose touchpoint was made from
-- the install's context (kind = 'context', never a recorded click) was reported.
update platform.attribution_events ae
   set match_type = 'reported'
  from platform.attribution_touchpoints t
 where t.id = ae.touchpoint_id and t.kind = 'context' and ae.match_type = 'deterministic';

-- Deferred deep links now claim the click they hand out (matched_at), so the
-- install engine's probabilistic step can't give the same click to another
-- install. Claims made before this migration get the same mark.
update platform.attribution_touchpoints t
   set matched_at = m.created_at
  from platform.deep_link_deferred_matches m
 where m.touchpoint_id = t.id and t.matched_at is null;
