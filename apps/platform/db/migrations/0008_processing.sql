-- Processing retries: an event whose processing hit a transient error
-- (deadlock, serialization failure) stays unprocessed and is retried; the
-- attempt counter stops a poison event from looping forever.
alter table platform.events add column processing_attempts smallint not null default 0;
