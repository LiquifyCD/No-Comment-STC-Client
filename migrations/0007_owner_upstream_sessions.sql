CREATE TABLE owner_upstream_sessions (
  owner_id TEXT PRIMARY KEY,
  session_ciphertext TEXT NOT NULL,
  upstream_expires_at INTEGER NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1,
  refresh_lock_until INTEGER,
  last_refresh_at TEXT,
  refresh_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK(refresh_status IN ('healthy', 'refresh_pending', 'refresh_failed', 'reauthorization_required')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_owner_upstream_sessions_refresh_due
  ON owner_upstream_sessions(refresh_status, upstream_expires_at, refresh_lock_until);

CREATE TABLE owner_upstream_session_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_upstream_sessions(owner_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('login', 'reauthorize', 'legacy_migration', 'refresh_success', 'refresh_failed')),
  status TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_owner_upstream_session_events_owner
  ON owner_upstream_session_events(owner_id, created_at DESC);
