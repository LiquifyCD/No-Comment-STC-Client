package store

import (
	"context"
	"database/sql"
	"errors"
)

// Owner session states.
const (
	StatusHealthy        = "healthy"
	StatusRefreshFailed  = "refresh_failed"
	StatusReauthRequired = "reauthorization_required"
)

// BrowserSession is one signed-in browser.
type BrowserSession struct {
	Owner      string
	Ciphertext string
	ExpiresAt  int64
}

// CreateBrowserSession stores a new browser session under the hash of its id.
func (s *Store) CreateBrowserSession(ctx context.Context, idHash, owner, ciphertext string, expiresAt int64, now string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO browser_sessions(id_hash,owner_id,session_ciphertext,expires_at,created_at) VALUES(?,?,?,?,?)`,
		idHash, owner, ciphertext, expiresAt, now)
	return err
}

// BrowserSession returns an unexpired browser session.
func (s *Store) BrowserSession(ctx context.Context, idHash string, nowMs int64) (BrowserSession, error) {
	var b BrowserSession
	err := s.db.QueryRowContext(ctx, `SELECT owner_id,session_ciphertext,expires_at FROM browser_sessions WHERE id_hash=? AND expires_at>?`, idHash, nowMs).
		Scan(&b.Owner, &b.Ciphertext, &b.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return b, ErrNotFound
	}
	return b, err
}

// UpdateBrowserSession replaces a browser session's upstream session.
func (s *Store) UpdateBrowserSession(ctx context.Context, idHash, ciphertext string, expiresAt int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE browser_sessions SET session_ciphertext=?,expires_at=? WHERE id_hash=?`, ciphertext, expiresAt, idHash)
	return err
}

// DeleteBrowserSession signs a browser out.
func (s *Store) DeleteBrowserSession(ctx context.Context, idHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM browser_sessions WHERE id_hash=?`, idHash)
	return err
}

// PurgeBrowserSessions drops expired browser sessions.
func (s *Store) PurgeBrowserSessions(ctx context.Context, nowMs int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM browser_sessions WHERE expires_at<=?`, nowMs)
	return err
}

// OwnerSession is the one upstream session device credentials act through.
type OwnerSession struct {
	Owner             string
	Ciphertext        string
	UpstreamExpiresAt int64
	Status            string
	LastRefreshAt     *string
	ReauthCiphertext  *string
	ReauthEnabled     bool
	NextReauthAt      *int64
	LastReauthAt      *string
}

func ownerEvent(ctx context.Context, tx *sql.Tx, id, owner, eventType, status string, durationMs *int64, now string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO owner_session_events(id,owner_id,event_type,status,duration_ms,created_at) VALUES(?,?,?,?,?,?)`,
		id, owner, eventType, status, durationMs, now)
	return err
}

// UpsertOwnerSession stores a fresh upstream session and marks it healthy.
func (s *Store) UpsertOwnerSession(ctx context.Context, eventID, owner, ciphertext string, upstreamExpiresAt int64, eventType, now string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO owner_sessions(owner_id,session_ciphertext,upstream_expires_at,status,created_at,updated_at) VALUES(?,?,?,'healthy',?,?)
			ON CONFLICT(owner_id) DO UPDATE SET session_ciphertext=excluded.session_ciphertext,upstream_expires_at=excluded.upstream_expires_at,
			status='healthy',last_error=NULL,last_refresh_at=NULL,updated_at=excluded.updated_at`,
			owner, ciphertext, upstreamExpiresAt, now, now); err != nil {
			return err
		}
		return ownerEvent(ctx, tx, eventID, owner, eventType, StatusHealthy, nil, now)
	})
}

// OwnerSession returns the owner's upstream session row.
func (s *Store) OwnerSession(ctx context.Context, owner string) (OwnerSession, error) {
	return scanOwnerSession(s.db.QueryRowContext(ctx, ownerSessionColumns+` FROM owner_sessions o WHERE o.owner_id=?`, owner))
}

const ownerSessionColumns = `SELECT o.owner_id,o.session_ciphertext,o.upstream_expires_at,o.status,o.last_refresh_at,o.reauth_ciphertext,o.reauth_enabled,o.next_reauth_at,o.last_reauth_at`

type scanner interface{ Scan(...any) error }

func scanOwnerSession(row scanner) (OwnerSession, error) {
	var (
		o                        OwnerSession
		refresh, creds, lastAuth sql.NullString
		next                     sql.NullInt64
	)
	err := row.Scan(&o.Owner, &o.Ciphertext, &o.UpstreamExpiresAt, &o.Status, &refresh, &creds, &o.ReauthEnabled, &next, &lastAuth)
	if errors.Is(err, sql.ErrNoRows) {
		return o, ErrNotFound
	}
	if err != nil {
		return o, err
	}
	o.LastRefreshAt, o.ReauthCiphertext, o.LastReauthAt = nullString(refresh), nullString(creds), nullString(lastAuth)
	if next.Valid {
		o.NextReauthAt = &next.Int64
	}
	return o, nil
}

// EnableReauth stores a fresh session together with the sealed login used
// to renew it.
func (s *Store) EnableReauth(ctx context.Context, eventID, owner, sessionCiphertext string, upstreamExpiresAt int64, credsCiphertext string, nextAt, durationMs int64, now string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO owner_sessions(owner_id,session_ciphertext,upstream_expires_at,status,last_refresh_at,reauth_ciphertext,reauth_enabled,next_reauth_at,last_reauth_at,created_at,updated_at)
			VALUES(?,?,?,'healthy',?,?,1,?,?,?,?)
			ON CONFLICT(owner_id) DO UPDATE SET session_ciphertext=excluded.session_ciphertext,upstream_expires_at=excluded.upstream_expires_at,
			status='healthy',last_error=NULL,last_refresh_at=excluded.last_refresh_at,reauth_ciphertext=excluded.reauth_ciphertext,reauth_enabled=1,
			next_reauth_at=excluded.next_reauth_at,last_reauth_at=excluded.last_reauth_at,updated_at=excluded.updated_at`,
			owner, sessionCiphertext, upstreamExpiresAt, now, credsCiphertext, nextAt, now, now, now); err != nil {
			return err
		}
		return ownerEvent(ctx, tx, eventID, owner, "reauthorize", "automatic_enabled", &durationMs, now)
	})
}

// RefreshReauthLogin replaces the stored login after a manual sign-in, when
// automatic renewal is already on.
func (s *Store) RefreshReauthLogin(ctx context.Context, owner, credsCiphertext string, nextAt int64, now string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE owner_sessions SET reauth_ciphertext=?,next_reauth_at=?,last_reauth_at=?,updated_at=? WHERE owner_id=? AND reauth_enabled=1`,
		credsCiphertext, nextAt, now, now, owner)
	return err
}

// DisableReauth turns automatic renewal off and deletes the stored login.
func (s *Store) DisableReauth(ctx context.Context, eventID, owner, now string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE owner_sessions SET reauth_ciphertext=NULL,reauth_enabled=0,next_reauth_at=NULL,updated_at=? WHERE owner_id=?`, now, owner); err != nil {
			return err
		}
		return ownerEvent(ctx, tx, eventID, owner, "reauthorize", "automatic_disabled", nil, now)
	})
}

// DueReauth lists owners whose renewal is due and who still have at least
// one usable device credential.
func (s *Store) DueReauth(ctx context.Context, nowMs int64, limit int) ([]OwnerSession, error) {
	rows, err := s.db.QueryContext(ctx, ownerSessionColumns+` FROM owner_sessions o
		WHERE o.reauth_enabled=1 AND o.reauth_ciphertext IS NOT NULL AND o.next_reauth_at IS NOT NULL AND o.next_reauth_at<=?
		AND EXISTS(SELECT 1 FROM device_sessions d WHERE d.owner_id=o.owner_id AND d.revoked_at IS NULL AND d.expires_at>?)
		ORDER BY o.next_reauth_at LIMIT ?`, nowMs, nowMs, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OwnerSession
	for rows.Next() {
		o, err := scanOwnerSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// SaveReauthSuccess stores the renewed session and the next renewal time.
func (s *Store) SaveReauthSuccess(ctx context.Context, eventID, owner, ciphertext string, upstreamExpiresAt, nextAt, durationMs int64, now string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE owner_sessions SET session_ciphertext=?,upstream_expires_at=?,status='healthy',last_error=NULL,
			last_refresh_at=?,next_reauth_at=?,last_reauth_at=?,updated_at=? WHERE owner_id=? AND reauth_enabled=1`,
			ciphertext, upstreamExpiresAt, now, nextAt, now, now, owner); err != nil {
			return err
		}
		return ownerEvent(ctx, tx, eventID, owner, "reauthorize", StatusHealthy, &durationMs, now)
	})
}

// SaveReauthFailure records a failed renewal. A permanent failure (disable)
// also deletes the stored login; a transient one schedules a retry.
func (s *Store) SaveReauthFailure(ctx context.Context, eventID, owner, status, lastError string, disable bool, retryAt, durationMs int64, now string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		if disable {
			_, err = tx.ExecContext(ctx, `UPDATE owner_sessions SET status=?,last_error=?,reauth_enabled=0,reauth_ciphertext=NULL,next_reauth_at=NULL,updated_at=? WHERE owner_id=?`,
				status, lastError, now, owner)
		} else {
			_, err = tx.ExecContext(ctx, `UPDATE owner_sessions SET status=?,last_error=?,next_reauth_at=?,updated_at=? WHERE owner_id=?`,
				status, lastError, retryAt, now, owner)
		}
		if err != nil {
			return err
		}
		return ownerEvent(ctx, tx, eventID, owner, "refresh_failed", status, &durationMs, now)
	})
}
