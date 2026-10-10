-- 0028: Idempotency-Key bound to its request payload.
-- A key replays its stored response only for the same events. payload_hash is
-- a sha256 of the request's ordered event identities (each event's event_id,
-- or the canonical JSON of an event that has none), so a retry whose sent_at or
-- JSON key order changed still replays, while a different batch under the same
-- key gets 409 idempotency_key_reused instead of a response for events it
-- never stored. Null on rows written before this migration: those keep
-- replaying as before.

alter table platform.event_batches add column payload_hash text;
