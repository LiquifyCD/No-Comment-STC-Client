ALTER TABLE owner_upstream_sessions
  ADD COLUMN scheduled_reauth_ciphertext TEXT;

ALTER TABLE owner_upstream_sessions
  ADD COLUMN scheduled_reauth_enabled INTEGER NOT NULL DEFAULT 0
  CHECK(scheduled_reauth_enabled IN (0, 1));

ALTER TABLE owner_upstream_sessions
  ADD COLUMN next_reauth_at INTEGER;

ALTER TABLE owner_upstream_sessions
  ADD COLUMN last_reauth_at TEXT;

CREATE INDEX idx_owner_upstream_sessions_scheduled_reauth
  ON owner_upstream_sessions(scheduled_reauth_enabled, next_reauth_at, refresh_lock_until);
