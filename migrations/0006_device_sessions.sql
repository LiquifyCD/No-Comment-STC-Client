CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  session_ciphertext TEXT NOT NULL,
  upstream_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  refresh_lock_until INTEGER,
  session_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(owner_id, name_key)
);

CREATE INDEX idx_device_sessions_owner ON device_sessions(owner_id, created_at DESC);

CREATE TABLE device_session_targets (
  device_session_id TEXT NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('door', 'sequence')),
  target_id TEXT NOT NULL,
  PRIMARY KEY(device_session_id, target_type, target_id)
);

CREATE TABLE device_session_events (
  id TEXT PRIMARY KEY,
  device_session_id TEXT NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_device_session_events_device ON device_session_events(device_session_id, created_at DESC);
