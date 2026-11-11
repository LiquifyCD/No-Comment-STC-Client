package store

import (
	"context"
	"database/sql"
	"errors"
)

// Reader is one saved door. A door is usable when it has either a fixed
// card reader code or a sealed major/minor pair to look one up with.
type Reader struct {
	ID           string
	Name         string
	CardReader   int
	Config       *string
	CreatedAt    string
	LastOpenedAt *string
}

// ReaderEvent is one audit entry of a door.
type ReaderEvent struct {
	ID, Type, DataJSON, CreatedAt string
}

const usableReader = `(config_ciphertext IS NOT NULL OR card_reader>0)`

// SeedDefaultReader gives a new owner the "Main entrance" door, once.
func (s *Store) SeedDefaultReader(ctx context.Context, id, owner string, cardReader int, now string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO reader_seeds(owner_id,seeded_at) VALUES(?,?)`, owner, now)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO readers(id,owner_id,name,name_key,card_reader,created_at) VALUES(?,?,'Main entrance','main entrance',?,?)`,
			id, owner, cardReader, now)
		return err
	})
}

// Readers lists the owner's doors, most recently used first.
func (s *Store) Readers(ctx context.Context, owner string) ([]Reader, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,card_reader,config_ciphertext,created_at,last_opened_at FROM readers WHERE owner_id=? ORDER BY COALESCE(last_opened_at,created_at) DESC`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Reader{}
	for rows.Next() {
		r, err := scanReader(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func scanReader(row scanner) (Reader, error) {
	var (
		r              Reader
		config, opened sql.NullString
	)
	err := row.Scan(&r.ID, &r.Name, &r.CardReader, &config, &r.CreatedAt, &opened)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	r.Config, r.LastOpenedAt = nullString(config), nullString(opened)
	return r, err
}

// Reader returns one of the owner's doors.
func (s *Store) Reader(ctx context.Context, owner, id string) (Reader, error) {
	return scanReader(s.db.QueryRowContext(ctx, `SELECT id,name,card_reader,config_ciphertext,created_at,last_opened_at FROM readers WHERE id=? AND owner_id=?`, id, owner))
}

// SaveConfiguredReader stores a door defined by a sealed major/minor pair.
// A seeded door with the same name is converted in place; a door that
// already has a pair is a conflict.
func (s *Store) SaveConfiguredReader(ctx context.Context, id, owner, name, nameKey, ciphertext, now string) (string, error) {
	var saved string
	err := s.db.QueryRowContext(ctx, `INSERT INTO readers(id,owner_id,name,name_key,card_reader,created_at,last_opened_at,config_ciphertext) VALUES(?,?,?,?,0,?,?,?)
		ON CONFLICT(owner_id,name_key) DO UPDATE SET name=excluded.name,card_reader=0,last_opened_at=excluded.last_opened_at,config_ciphertext=excluded.config_ciphertext
		WHERE readers.config_ciphertext IS NULL RETURNING id`, id, owner, name, nameKey, now, now, ciphertext).Scan(&saved)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrConflict
	}
	return saved, err
}

// TouchReader marks a door as just viewed.
func (s *Store) TouchReader(ctx context.Context, owner, id, now string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE readers SET last_opened_at=? WHERE id=? AND owner_id=?`, now, id, owner)
	return err
}

// ReaderEvents returns a door's latest audit entries.
func (s *Store) ReaderEvents(ctx context.Context, owner, id string, limit int) ([]ReaderEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,event_type,data_json,created_at FROM reader_events WHERE reader_id=? AND owner_id=? ORDER BY created_at DESC LIMIT ?`, id, owner, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReaderEvent{}
	for rows.Next() {
		var e ReaderEvent
		if err := rows.Scan(&e.ID, &e.Type, &e.DataJSON, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// AddReaderEvent appends an audit entry to a door.
func (s *Store) AddReaderEvent(ctx context.Context, id, readerID, owner, eventType, dataJSON, now string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO reader_events(id,reader_id,owner_id,event_type,data_json,created_at) VALUES(?,?,?,?,?,?)`,
		id, readerID, owner, eventType, dataJSON, now)
	return err
}

// RenameReader renames a door.
func (s *Store) RenameReader(ctx context.Context, owner, id, name, nameKey string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE readers SET name=?,name_key=? WHERE id=? AND owner_id=?`, name, nameKey, id, owner)
	if isUnique(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteReader removes a door, then every sequence it leaves without steps
// and any default selection that now points nowhere. Device allowlist
// entries for the door are kept on purpose: removing the last one would turn
// a restricted credential into an unrestricted one.
func (s *Store) DeleteReader(ctx context.Context, owner, id string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM readers WHERE id=? AND owner_id=?`, id, owner)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		for _, q := range []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM sequences WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM sequence_steps WHERE sequence_steps.sequence_id=sequences.id)`, []any{owner}},
			{`DELETE FROM user_preferences WHERE owner_id=? AND default_type='door' AND default_id=?`, []any{owner, id}},
			{`DELETE FROM user_preferences WHERE owner_id=? AND default_type='sequence' AND NOT EXISTS(SELECT 1 FROM sequences WHERE sequences.id=user_preferences.default_id AND sequences.owner_id=user_preferences.owner_id)`, []any{owner}},
		} {
			if _, err := tx.ExecContext(ctx, q.sql, q.args...); err != nil {
				return err
			}
		}
		return nil
	})
}

// UsableReaderIDs returns up to two usable doors with that name.
func (s *Store) UsableReaderIDs(ctx context.Context, owner, nameKey string) ([]string, error) {
	return s.ids(ctx, `SELECT id FROM readers WHERE owner_id=? AND name_key=? AND `+usableReader+` LIMIT 2`, owner, nameKey)
}

// UsableReader returns a door only if it can be opened.
func (s *Store) UsableReader(ctx context.Context, owner, id string) (Reader, error) {
	return scanReader(s.db.QueryRowContext(ctx, `SELECT id,name,card_reader,config_ciphertext,created_at,last_opened_at FROM readers WHERE id=? AND owner_id=? AND `+usableReader, id, owner))
}

func (s *Store) ids(ctx context.Context, query string, args ...any) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
