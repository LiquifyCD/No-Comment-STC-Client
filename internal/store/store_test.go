package store

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

const stamp = "2026-10-04T12:00:00.000Z"

func open(t *testing.T) *Store {
	t.Helper()
	st, err := Open(context.Background(), filepath.Join(t.TempDir(), "stc.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func door(t *testing.T, st *Store, id, owner, name, key string) string {
	t.Helper()
	saved, err := st.SaveConfiguredReader(context.Background(), id, owner, name, key, "sealed", stamp)
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestReopeningKeepsData(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "stc.db")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	door(t, st, "r1", "anna", "Gym", "gym")
	st.Close()
	st, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if readers, err := st.Readers(ctx, "anna"); err != nil || len(readers) != 1 {
		t.Fatalf("readers = %v, %v", readers, err)
	}
}

func TestOwnersAreIsolated(t *testing.T) {
	ctx := context.Background()
	st := open(t)
	id := door(t, st, "r1", "anna", "Gym", "gym")
	if err := st.SaveSequence(ctx, "anna", "s1", false, "In", "in", []SequenceStep{{ReaderID: id}}, stamp); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateDevice(ctx, "e1", Device{ID: "d1", Owner: "anna", Name: "Phone", TokenHash: "h", ExpiresAt: NeverExpires}, "phone", stamp); err != nil {
		t.Fatal(err)
	}

	if _, err := st.Reader(ctx, "bo", id); !errors.Is(err, ErrNotFound) {
		t.Errorf("Reader: %v", err)
	}
	if _, err := st.UsableReader(ctx, "bo", id); !errors.Is(err, ErrNotFound) {
		t.Errorf("UsableReader: %v", err)
	}
	if err := st.RenameReader(ctx, "bo", id, "Mine", "mine"); !errors.Is(err, ErrNotFound) {
		t.Errorf("RenameReader: %v", err)
	}
	if err := st.DeleteReader(ctx, "bo", id); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteReader: %v", err)
	}
	if _, err := st.SequenceSteps(ctx, "bo", "s1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("SequenceSteps: %v", err)
	}
	if err := st.DeleteSequence(ctx, "bo", "s1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteSequence: %v", err)
	}
	if _, err := st.OwnedDevice(ctx, "bo", "d1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("OwnedDevice: %v", err)
	}
	if err := st.RevokeDevice(ctx, "e2", "bo", "d1", stamp); !errors.Is(err, ErrNotFound) {
		t.Errorf("RevokeDevice: %v", err)
	}
	if owned, err := st.OwnsTarget(ctx, "bo", "door", id); err != nil || owned {
		t.Errorf("OwnsTarget = %v, %v", owned, err)
	}
	if ids, err := st.UsableReaderIDs(ctx, "bo", "gym"); err != nil || len(ids) != 0 {
		t.Errorf("UsableReaderIDs = %v, %v", ids, err)
	}
	// The same name is free for another owner.
	door(t, st, "r2", "bo", "Gym", "gym")
}

func TestSeededDoorIsCreatedOnceAndCanBeConfigured(t *testing.T) {
	ctx := context.Background()
	st := open(t)
	for _, id := range []string{"r1", "r2"} {
		if err := st.SeedDefaultReader(ctx, id, "anna", 55, stamp); err != nil {
			t.Fatal(err)
		}
	}
	readers, err := st.Readers(ctx, "anna")
	if err != nil || len(readers) != 1 || readers[0].ID != "r1" || readers[0].CardReader != 55 {
		t.Fatalf("readers = %+v, %v", readers, err)
	}
	// Saving a beacon pair under the seeded name converts that door in place.
	if saved := door(t, st, "r3", "anna", "Main entrance", "main entrance"); saved != "r1" {
		t.Fatalf("saved as %q, want the seeded door", saved)
	}
	converted, err := st.UsableReader(ctx, "anna", "r1")
	if err != nil || converted.Config == nil || converted.CardReader != 0 {
		t.Fatalf("converted = %+v, %v", converted, err)
	}
	if _, err := st.SaveConfiguredReader(ctx, "r4", "anna", "Main entrance", "main entrance", "sealed", stamp); !errors.Is(err, ErrConflict) {
		t.Fatalf("second save: %v", err)
	}
}

func TestDeletingADoorKeepsDeviceAllowlists(t *testing.T) {
	ctx := context.Background()
	st := open(t)
	gym := door(t, st, "r1", "anna", "Gym", "gym")
	sauna := door(t, st, "r2", "anna", "Sauna", "sauna")
	if err := st.SaveSequence(ctx, "anna", "s1", false, "Only gym", "only gym", []SequenceStep{{ReaderID: gym}}, stamp); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSequence(ctx, "anna", "s2", false, "Both", "both", []SequenceStep{{ReaderID: gym, DelayAfterMs: 1000}, {ReaderID: sauna}}, stamp); err != nil {
		t.Fatal(err)
	}
	if err := st.SetDefault(ctx, "anna", "sequence", "s1", stamp); err != nil {
		t.Fatal(err)
	}
	device := Device{ID: "d1", Owner: "anna", Name: "Phone", TokenHash: "h", ExpiresAt: NeverExpires, Targets: []DeviceTarget{{Type: "door", ID: gym}}}
	if err := st.CreateDevice(ctx, "e1", device, "phone", stamp); err != nil {
		t.Fatal(err)
	}

	if err := st.DeleteReader(ctx, "anna", gym); err != nil {
		t.Fatal(err)
	}
	// An empty allowlist means "everything", so the entry must survive.
	if ids, err := st.DeviceTargetIDs(ctx, "d1"); err != nil || len(ids) != 1 || ids[0] != gym {
		t.Fatalf("allowlist = %v, %v", ids, err)
	}
	sequences, err := st.Sequences(ctx, "anna")
	if err != nil || len(sequences) != 1 || sequences[0].ID != "s2" || len(sequences[0].Steps) != 1 {
		t.Fatalf("sequences = %+v, %v", sequences, err)
	}
	selection, err := st.DefaultSelection(ctx, "anna")
	if err != nil || selection == nil || selection.Type != "door" || selection.ID != sauna {
		t.Fatalf("default = %+v, %v", selection, err)
	}
	devices, err := st.Devices(ctx, "anna")
	if err != nil || len(devices) != 1 || len(devices[0].Targets) != 0 {
		t.Fatalf("devices = %+v, %v (a deleted target has no name to show)", devices, err)
	}
}

func TestRenewalIsDueOnlyWithALiveDevice(t *testing.T) {
	ctx := context.Background()
	st := open(t)
	const now = int64(1_000_000)
	if err := st.EnableReauth(ctx, "e1", "anna", "session", now+500, "login", now-1, 3, stamp); err != nil {
		t.Fatal(err)
	}
	due := func() int {
		t.Helper()
		rows, err := st.DueReauth(ctx, now, 12)
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}
	if due() != 0 {
		t.Fatal("due without any device credential")
	}
	if err := st.CreateDevice(ctx, "e2", Device{ID: "d1", Owner: "anna", Name: "Phone", TokenHash: "h", ExpiresAt: NeverExpires}, "phone", stamp); err != nil {
		t.Fatal(err)
	}
	if due() != 1 {
		t.Fatal("not due with a live device credential")
	}
	if err := st.RevokeDevice(ctx, "e3", "anna", "d1", stamp); err != nil {
		t.Fatal(err)
	}
	if due() != 0 {
		t.Fatal("due with only a revoked device credential")
	}
	if err := st.RotateDevice(ctx, "e4", "anna", "d1", "h2", stamp); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveReauthFailure(ctx, "e5", "anna", StatusReauthRequired, "credentials_rejected", true, 0, 3, stamp); err != nil {
		t.Fatal(err)
	}
	o, err := st.OwnerSession(ctx, "anna")
	if err != nil || o.ReauthEnabled || o.ReauthCiphertext != nil || o.NextReauthAt != nil || o.Status != StatusReauthRequired {
		t.Fatalf("after a permanent failure = %+v, %v", o, err)
	}
	if due() != 0 {
		t.Fatal("due after renewal was turned off")
	}
}

func TestReadsRunInParallelAndWritersQueue(t *testing.T) {
	ctx := context.Background()
	st := open(t)
	if got := st.db.Stats().MaxOpenConnections; got != 8 {
		t.Fatalf("max open connections = %d, want 8", got)
	}
	// A read that is still open must not block another query.
	rows, err := st.db.QueryContext(ctx, `SELECT name FROM sqlite_master`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if err := st.Ping(ctx); err != nil {
		t.Fatal(err)
	}

	const writers, each = 16, 25
	errs := make(chan error, writers*each)
	var wg sync.WaitGroup
	for w := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range each {
				errs <- st.UpsertOwnerSession(ctx, fmt.Sprintf("e%d-%d", w, i), fmt.Sprintf("owner%d", w%4), "sealed", 1, "login", stamp)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent write: %v", err)
		}
	}
}

func TestDeviceEventsAreIndexedBySession(t *testing.T) {
	st := open(t)
	var table string
	err := st.db.QueryRow(`SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='device_session_events_session'`).Scan(&table)
	if err != nil || table != "device_session_events" {
		t.Fatalf("index on %q, %v", table, err)
	}
}
