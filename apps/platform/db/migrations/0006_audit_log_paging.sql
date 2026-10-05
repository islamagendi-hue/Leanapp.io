-- Keyset paging for the audit log viewer (newest first by id).
create index audit_logs_org_id_idx on platform.audit_logs (organization_id, id desc);
