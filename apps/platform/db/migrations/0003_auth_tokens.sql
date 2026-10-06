-- One-time tokens for email verification and password reset.
-- System-only: never granted to platform_app. Only the SHA-256 of a token is stored.
create table platform.auth_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references platform.users(id) on delete cascade,
  purpose     text not null check (purpose in ('verify_email', 'reset_password')),
  token_hash  text not null unique,
  email       text not null,                       -- the address the token was sent to
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index auth_tokens_user_idx on platform.auth_tokens (user_id, purpose) where used_at is null;
