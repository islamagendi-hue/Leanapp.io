-- 0020: pin search_path on platform functions (Supabase security advisor 0011,
-- function_search_path_mutable). Every body already schema-qualifies its objects,
-- so an empty search_path changes nothing except closing the hijack route.
alter function platform.current_org_id() set search_path = '';
alter function platform.current_user_id() set search_path = '';
alter function platform.touch_updated_at() set search_path = '';
alter function platform.record_event_mapping_change() set search_path = '';
