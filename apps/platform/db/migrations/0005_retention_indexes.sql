-- Scheduled cleanup deletes by age across all tenants; these keep it off sequential scans.
create index api_request_logs_created_idx on platform.api_request_logs (created_at);
create index event_batches_received_idx on platform.event_batches (received_at);
