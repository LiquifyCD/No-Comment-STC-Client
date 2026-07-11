PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS readers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  card_reader INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_opened_at TEXT,
  UNIQUE (owner_id, name_key)
);

CREATE INDEX IF NOT EXISTS readers_owner_created_idx
  ON readers (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reader_events (
  id TEXT PRIMARY KEY,
  reader_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reader_id) REFERENCES readers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reader_events_reader_created_idx
  ON reader_events (reader_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reader_migrations (
  owner_id TEXT PRIMARY KEY,
  migrated_at TEXT NOT NULL
);
