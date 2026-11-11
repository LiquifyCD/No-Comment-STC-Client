package store

import (
	"context"
	"database/sql"
	"errors"
)

// Device is one device credential.
type Device struct {
	ID, Owner, Name, TokenHash string
	ExpiresAt                  int64
	CreatedAt, UpdatedAt       string
	LastUsedAt, RevokedAt      *string
	Targets                    []DeviceTarget
}

// DeviceTarget is one door or sequence a credential is limited to. A
// credential with no targets may open everything its owner has.
type DeviceTarget struct {
	Type string
	ID   string
	Name string
}

func deviceEvent(ctx context.Context, tx *sql.Tx, eventID, deviceID, owner, eventType, now string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO device_session_events(id,device_session_id,owner_id,event_type,created_at) VALUES(?,?,?,?,?)`,
		eventID, deviceID, owner, eventType, now)
	return err
}

// OwnsTarget reports whether a door or sequence id belongs to the owner.
func (s *Store) OwnsTarget(ctx context.Context, owner, kind, id string) (bool, error) {
	table := "sequences"
	if kind == "door" {
		table = "readers"
	}
	var found string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM `+table+` WHERE id=? AND owner_id=?`, id, owner).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// CreateDevice stores a new credential with its allowlist.
func (s *Store) CreateDevice(ctx context.Context, eventID string, d Device, nameKey, now string) error {
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO device_sessions(id,owner_id,name,name_key,token_hash,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
			d.ID, d.Owner, d.Name, nameKey, d.TokenHash, d.ExpiresAt, now, now); err != nil {
			return err
		}
		for _, target := range d.Targets {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO device_session_targets(device_session_id,target_type,target_id) VALUES(?,?,?)`, d.ID, target.Type, target.ID); err != nil {
				return err
			}
		}
		return deviceEvent(ctx, tx, eventID, d.ID, d.Owner, "create", now)
	})
	if isUnique(err) {
		return ErrConflict
	}
	return err
}

const deviceColumns = `SELECT id,owner_id,name,token_hash,expires_at,created_at,updated_at,last_used_at,revoked_at FROM device_sessions`

func scanDevice(row scanner) (Device, error) {
	var (
		d             Device
		used, revoked sql.NullString
	)
	err := row.Scan(&d.ID, &d.Owner, &d.Name, &d.TokenHash, &d.ExpiresAt, &d.CreatedAt, &d.UpdatedAt, &used, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return d, ErrNotFound
	}
	d.LastUsedAt, d.RevokedAt = nullString(used), nullString(revoked)
	return d, err
}

// Device returns a credential by id, whoever owns it. Only the device API
// uses it, to check the presented secret.
func (s *Store) Device(ctx context.Context, id string) (Device, error) {
	return scanDevice(s.db.QueryRowContext(ctx, deviceColumns+` WHERE id=?`, id))
}

// OwnedDevice returns one of the owner's credentials.
func (s *Store) OwnedDevice(ctx context.Context, owner, id string) (Device, error) {
	return scanDevice(s.db.QueryRowContext(ctx, deviceColumns+` WHERE id=? AND owner_id=?`, id, owner))
}

// Devices lists the owner's credentials, newest first, with the names of
// the targets each is limited to.
func (s *Store) Devices(ctx context.Context, owner string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, deviceColumns+` WHERE owner_id=? ORDER BY created_at DESC`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	targets, err := s.db.QueryContext(ctx, `SELECT dst.device_session_id,dst.target_type,dst.target_id,CASE dst.target_type WHEN 'door' THEN r.name ELSE s.name END
		FROM device_session_targets dst JOIN device_sessions ds ON ds.id=dst.device_session_id
		LEFT JOIN readers r ON dst.target_type='door' AND r.id=dst.target_id AND r.owner_id=ds.owner_id
		LEFT JOIN sequences s ON dst.target_type='sequence' AND s.id=dst.target_id AND s.owner_id=ds.owner_id
		WHERE ds.owner_id=?`, owner)
	if err != nil {
		return nil, err
	}
	defer targets.Close()
	byDevice := map[string][]DeviceTarget{}
	for targets.Next() {
		var (
			device string
			target DeviceTarget
			name   sql.NullString
		)
		if err := targets.Scan(&device, &target.Type, &target.ID, &name); err != nil {
			return nil, err
		}
		if name.Valid {
			target.Name = name.String
			byDevice[device] = append(byDevice[device], target)
		}
	}
	if err := targets.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Targets = byDevice[out[i].ID]
	}
	return out, nil
}

// DeviceTargetIDs returns a credential's allowlist; empty means everything.
func (s *Store) DeviceTargetIDs(ctx context.Context, deviceID string) ([]string, error) {
	return s.ids(ctx, `SELECT target_id FROM device_session_targets WHERE device_session_id=?`, deviceID)
}

func (s *Store) changeDevice(ctx context.Context, eventID, owner, id, eventType, now, set string, args ...any) error {
	err := s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE device_sessions SET `+set+` WHERE id=? AND owner_id=?`, append(args, id, owner)...)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return deviceEvent(ctx, tx, eventID, id, owner, eventType, now)
	})
	if isUnique(err) {
		return ErrConflict
	}
	return err
}

// RevokeDevice stops a credential from working.
func (s *Store) RevokeDevice(ctx context.Context, eventID, owner, id, now string) error {
	return s.changeDevice(ctx, eventID, owner, id, "revoke", now, `revoked_at=?,updated_at=?`, now, now)
}

// RotateDevice replaces a credential's secret and re-enables it.
func (s *Store) RotateDevice(ctx context.Context, eventID, owner, id, tokenHash, now string) error {
	return s.changeDevice(ctx, eventID, owner, id, "rotate", now, `token_hash=?,revoked_at=NULL,updated_at=?`, tokenHash, now)
}

// RenameDevice renames a credential.
func (s *Store) RenameDevice(ctx context.Context, eventID, owner, id, name, nameKey, now string) error {
	return s.changeDevice(ctx, eventID, owner, id, "rename", now, `name=?,name_key=?,updated_at=?`, name, nameKey, now)
}

// NoteDevice records an audit event that changes nothing else.
func (s *Store) NoteDevice(ctx context.Context, eventID, owner, id, eventType, now string) error {
	return s.changeDevice(ctx, eventID, owner, id, eventType, now, `updated_at=?`, now)
}

// MarkDeviceUsed records that a credential opened something.
func (s *Store) MarkDeviceUsed(ctx context.Context, eventID, owner, id, now string) error {
	return s.changeDevice(ctx, eventID, owner, id, "use", now, `last_used_at=?,updated_at=?`, now, now)
}
