PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sequences (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, name_key)
);

CREATE INDEX IF NOT EXISTS sequences_owner_updated_idx ON sequences (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sequence_steps (
  sequence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 8),
  reader_id TEXT NOT NULL,
  delay_after_ms INTEGER NOT NULL CHECK (delay_after_ms >= 0 AND delay_after_ms <= 10000),
  PRIMARY KEY (sequence_id, position),
  FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE,
  FOREIGN KEY (reader_id) REFERENCES readers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sequence_steps_reader_idx ON sequence_steps (reader_id);

CREATE TABLE IF NOT EXISTS user_preferences (
  owner_id TEXT PRIMARY KEY,
  default_type TEXT NOT NULL CHECK (default_type IN ('door', 'sequence')),
  default_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_events (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  completed_steps INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sequence_events_sequence_created_idx ON sequence_events (sequence_id, created_at DESC);
