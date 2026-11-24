-- FlashSale schema v2: accounts (password login) and server-side sessions.
--
-- Guest bookings (v1) created `users` rows without a password. Those rows stay valid: a person can
-- later "claim" their e-mail by signing up, which only fills in password_hash.

ALTER TABLE users
  ADD COLUMN password_hash  TEXT,                 -- scrypt$N$r$p$salt$hash ; NULL = guest (never logged in)
  ADD COLUMN last_login_at  TIMESTAMPTZ;

-- Opaque, revocable session tokens. Only the SHA-256 of the token is stored, so a database leak
-- does not hand out usable sessions.
CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX sessions_user_idx    ON sessions (user_id, created_at DESC);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
