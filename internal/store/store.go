// Package store is the STC client's SQLite persistence. Every row is scoped
// by an owner id (a keyed hash of the BRP customer id), and every query takes
// that owner so one account can never read or change another's rows.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when the requested row does not exist for the owner.
var ErrNotFound = errors.New("not found")

// ErrConflict is returned when a name is already taken for the owner.
var ErrConflict = errors.New("conflict")

// NeverExpires is the expires_at of a device credential with no expiry.
const NeverExpires int64 = 253402300799000

// Store wraps the database.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS readers (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  name              TEXT NOT NULL,
  name_key          TEXT NOT NULL,
  card_reader       INTEGER NOT NULL DEFAULT 0,
  config_ciphertext TEXT,
  created_at        TEXT NOT NULL,
  last_opened_at    TEXT,
  UNIQUE(owner_id, name_key)
);
CREATE TABLE IF NOT EXISTS reader_events (
  id         TEXT PRIMARY KEY,
  reader_id  TEXT NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  owner_id   TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reader_events_reader ON reader_events(reader_id, created_at);
CREATE TABLE IF NOT EXISTS reader_seeds (
  owner_id  TEXT PRIMARY KEY,
  seeded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sequences (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, name_key)
);
CREATE TABLE IF NOT EXISTS sequence_steps (
  sequence_id    TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
  reader_id      TEXT NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  delay_after_ms INTEGER NOT NULL CHECK(delay_after_ms BETWEEN 0 AND 10000),
  PRIMARY KEY(sequence_id, position)
);
CREATE TABLE IF NOT EXISTS sequence_events (
  id              TEXT PRIMARY KEY,
  sequence_id     TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  completed_steps INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_preferences (
  owner_id     TEXT PRIMARY KEY,
  default_type TEXT NOT NULL CHECK(default_type IN ('door','sequence')),
  default_id   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_sessions (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  UNIQUE(owner_id, name_key)
);
CREATE TABLE IF NOT EXISTS device_session_targets (
  device_session_id TEXT NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
  target_type       TEXT NOT NULL CHECK(target_type IN ('door','sequence')),
  target_id         TEXT NOT NULL,
  PRIMARY KEY(device_session_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS device_session_events (
  id                TEXT PRIMARY KEY,
  device_session_id TEXT NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS device_session_events_session ON device_session_events(device_session_id);
CREATE TABLE IF NOT EXISTS owner_sessions (
  owner_id            TEXT PRIMARY KEY,
  session_ciphertext  TEXT NOT NULL,
  upstream_expires_at INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK(status IN ('healthy','refresh_failed','reauthorization_required')),
  last_error          TEXT,
  last_refresh_at     TEXT,
  reauth_ciphertext   TEXT,
  reauth_enabled      INTEGER NOT NULL DEFAULT 0,
  next_reauth_at      INTEGER,
  last_reauth_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_session_events (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  status      TEXT NOT NULL,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_sessions (
  id_hash            TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL,
  session_ciphertext TEXT NOT NULL,
  expires_at         INTEGER NOT NULL,
  created_at         TEXT NOT NULL
);
`

// Open opens (creating if needed) the database at path.
func Open(ctx context.Context, path string) (*Store, error) {
	// _txlock=immediate: with several connections a transaction must take the
	// write lock when it begins, where busy_timeout makes it wait its turn. A
	// deferred one that reads and then writes fails at once instead.
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8) // WAL: reads run in parallel, writers queue on the lock
	db.SetMaxIdleConns(4)
	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Ping reports whether the database answers.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// Stamp formats t the way the API reports times: UTC with milliseconds.
func Stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func nullString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}
