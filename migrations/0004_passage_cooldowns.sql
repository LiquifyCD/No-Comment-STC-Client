CREATE TABLE IF NOT EXISTS passage_cooldowns (
  owner_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  last_attempt_ms INTEGER NOT NULL,
  PRIMARY KEY (owner_id, reader_id),
  FOREIGN KEY (reader_id) REFERENCES readers(id) ON DELETE CASCADE
);
