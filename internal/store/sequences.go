package store

import (
	"context"
	"database/sql"
	"errors"
)

// Sequence is a named list of doors opened in order.
type Sequence struct {
	ID, Name, CreatedAt, UpdatedAt string
	Steps                          []SequenceStep
}

// SequenceStep is one door of a sequence and the pause after it.
type SequenceStep struct {
	ReaderID     string
	DoorName     string
	DelayAfterMs int
}

// Selection is the door or sequence the app opens by default.
type Selection struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// hasSteps is true for a sequence that still has at least one of the
// owner's doors in it.
const hasSteps = `EXISTS(SELECT 1 FROM sequence_steps ss JOIN readers r ON r.id=ss.reader_id AND r.owner_id=s.owner_id WHERE ss.sequence_id=s.id)`

// Sequences lists the owner's sequences that have steps, newest edit first.
func (s *Store) Sequences(ctx context.Context, owner string) ([]Sequence, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,created_at,updated_at FROM sequences WHERE owner_id=? ORDER BY updated_at DESC`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var all []Sequence
	for rows.Next() {
		var q Sequence
		if err := rows.Scan(&q.ID, &q.Name, &q.CreatedAt, &q.UpdatedAt); err != nil {
			return nil, err
		}
		all = append(all, q)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	steps, err := s.db.QueryContext(ctx, `SELECT ss.sequence_id,ss.reader_id,r.name,ss.delay_after_ms FROM sequence_steps ss
		JOIN sequences s ON s.id=ss.sequence_id JOIN readers r ON r.id=ss.reader_id AND r.owner_id=s.owner_id
		WHERE s.owner_id=? ORDER BY ss.sequence_id,ss.position`, owner)
	if err != nil {
		return nil, err
	}
	defer steps.Close()
	bySequence := map[string][]SequenceStep{}
	for steps.Next() {
		var (
			id   string
			step SequenceStep
		)
		if err := steps.Scan(&id, &step.ReaderID, &step.DoorName, &step.DelayAfterMs); err != nil {
			return nil, err
		}
		bySequence[id] = append(bySequence[id], step)
	}
	if err := steps.Err(); err != nil {
		return nil, err
	}
	out := []Sequence{}
	for _, q := range all {
		if q.Steps = bySequence[q.ID]; len(q.Steps) > 0 {
			out = append(out, q)
		}
	}
	return out, nil
}

// SequenceSteps returns the steps of one of the owner's sequences.
func (s *Store) SequenceSteps(ctx context.Context, owner, id string) ([]SequenceStep, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT ss.reader_id,r.name,ss.delay_after_ms FROM sequence_steps ss
		JOIN sequences s ON s.id=ss.sequence_id JOIN readers r ON r.id=ss.reader_id
		WHERE ss.sequence_id=? AND s.owner_id=? AND r.owner_id=? ORDER BY ss.position`, id, owner, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SequenceStep
	for rows.Next() {
		var step SequenceStep
		if err := rows.Scan(&step.ReaderID, &step.DoorName, &step.DelayAfterMs); err != nil {
			return nil, err
		}
		out = append(out, step)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

// SaveSequence creates a sequence, or replaces the name and steps of an
// existing one when update is true.
func (s *Store) SaveSequence(ctx context.Context, owner, id string, update bool, name, nameKey string, steps []SequenceStep, now string) error {
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if update {
			res, err := tx.ExecContext(ctx, `UPDATE sequences SET name=?,name_key=?,updated_at=? WHERE id=? AND owner_id=?`, name, nameKey, now, id, owner)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return ErrNotFound
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM sequence_steps WHERE sequence_id=?`, id); err != nil {
				return err
			}
		} else if _, err := tx.ExecContext(ctx, `INSERT INTO sequences(id,owner_id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?,?)`, id, owner, name, nameKey, now, now); err != nil {
			return err
		}
		for position, step := range steps {
			if _, err := tx.ExecContext(ctx, `INSERT INTO sequence_steps(sequence_id,position,reader_id,delay_after_ms) VALUES(?,?,?,?)`, id, position, step.ReaderID, step.DelayAfterMs); err != nil {
				return err
			}
		}
		return nil
	})
	if isUnique(err) {
		return ErrConflict
	}
	return err
}

// DeleteSequence removes a sequence and a default selection pointing at it.
// Device allowlist entries are kept, as in DeleteReader.
func (s *Store) DeleteSequence(ctx context.Context, owner, id string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM sequences WHERE id=? AND owner_id=?`, id, owner)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM user_preferences WHERE owner_id=? AND default_type='sequence' AND default_id=?`, owner, id)
		return err
	})
}

// SequenceIDs returns up to two of the owner's sequences with that name.
func (s *Store) SequenceIDs(ctx context.Context, owner, nameKey string) ([]string, error) {
	return s.ids(ctx, `SELECT id FROM sequences WHERE owner_id=? AND name_key=? LIMIT 2`, owner, nameKey)
}

// AddSequenceEvent records one run of a sequence.
func (s *Store) AddSequenceEvent(ctx context.Context, id, sequenceID, owner, outcome string, completedSteps int, now string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO sequence_events(id,sequence_id,owner_id,outcome,completed_steps,created_at) VALUES(?,?,?,?,?,?)`,
		id, sequenceID, owner, outcome, completedSteps, now)
	return err
}

// DefaultCandidates returns up to two doors or runnable sequences with that
// name, for choosing the default.
func (s *Store) DefaultCandidates(ctx context.Context, owner, kind, nameKey string) ([]string, error) {
	if kind == "door" {
		return s.ids(ctx, `SELECT id FROM readers WHERE owner_id=? AND name_key=? LIMIT 2`, owner, nameKey)
	}
	return s.ids(ctx, `SELECT s.id FROM sequences s WHERE s.owner_id=? AND s.name_key=? AND `+hasSteps+` LIMIT 2`, owner, nameKey)
}

// SetDefault stores the owner's default selection.
func (s *Store) SetDefault(ctx context.Context, owner, kind, id, now string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO user_preferences(owner_id,default_type,default_id,updated_at) VALUES(?,?,?,?)
		ON CONFLICT(owner_id) DO UPDATE SET default_type=excluded.default_type,default_id=excluded.default_id,updated_at=excluded.updated_at`, owner, kind, id, now)
	return err
}

// DefaultSelection is the stored default if it still exists, else the most
// recent door, else the most recently edited sequence, else nil.
func (s *Store) DefaultSelection(ctx context.Context, owner string) (*Selection, error) {
	first := func(kind, query string, args ...any) (*Selection, error) {
		var id string
		err := s.db.QueryRowContext(ctx, query, args...).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &Selection{Type: kind, ID: id}, nil
	}
	var kind, id string
	err := s.db.QueryRowContext(ctx, `SELECT default_type,default_id FROM user_preferences WHERE owner_id=?`, owner).Scan(&kind, &id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	candidates := []struct {
		use   bool
		kind  string
		query string
		args  []any
	}{
		{kind == "door", "door", `SELECT id FROM readers WHERE id=? AND owner_id=?`, []any{id, owner}},
		{kind == "sequence", "sequence", `SELECT s.id FROM sequences s WHERE s.id=? AND s.owner_id=? AND ` + hasSteps, []any{id, owner}},
		{true, "door", `SELECT id FROM readers WHERE owner_id=? ORDER BY COALESCE(last_opened_at,created_at) DESC LIMIT 1`, []any{owner}},
		{true, "sequence", `SELECT s.id FROM sequences s WHERE s.owner_id=? AND ` + hasSteps + ` ORDER BY s.updated_at DESC LIMIT 1`, []any{owner}},
	}
	for _, c := range candidates {
		if !c.use {
			continue
		}
		if sel, err := first(c.kind, c.query, c.args...); err != nil || sel != nil {
			return sel, err
		}
	}
	return nil, nil
}
