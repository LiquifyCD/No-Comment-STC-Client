package web

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

const (
	reauthInterval = 30 * time.Minute
	reauthBatch    = 12
	reauthEvery    = 3 * 24 * time.Hour // renew at least this often
	reauthMargin   = 36 * time.Hour     // and this long before the session expires
	reauthRetry    = 12 * time.Hour     // after a failure that may pass
)

// nextReauthAt is when a session expiring at expiresAt should be renewed.
func nextReauthAt(nowMs, expiresAt int64) int64 {
	return max(nowMs, min(nowMs+reauthEvery.Milliseconds(), expiresAt-reauthMargin.Milliseconds()))
}

// RunMaintenance renews due upstream sessions and drops expired browser
// sessions, now and then every half hour until ctx ends.
func (s *Server) RunMaintenance(ctx context.Context) {
	ticker := time.NewTicker(reauthInterval)
	defer ticker.Stop()
	for {
		s.maintain(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) maintain(ctx context.Context) {
	nowMs := s.now().UnixMilli()
	if err := s.st.PurgeBrowserSessions(ctx, nowMs); err != nil {
		log.Printf("purge browser sessions: %v", err)
	}
	due, err := s.st.DueReauth(ctx, nowMs, reauthBatch)
	if err != nil {
		log.Printf("scheduled reauthorization: %v", err)
		return
	}
	for _, o := range due {
		result, err := s.reauthorize(ctx, o)
		if err != nil {
			log.Printf("scheduled reauthorization: %v", err)
		}
		logEvent("scheduled_session_reauthorization", map[string]any{"outcome": result})
	}
}

// reauthorize logs one owner in again with the stored login. A rejected or
// unusable login turns renewal off and deletes it; anything else is retried.
func (s *Server) reauthorize(ctx context.Context, o store.OwnerSession) (string, error) {
	started := s.now()
	stamp := func() (int64, string) {
		now := s.now()
		return now.Sub(started).Milliseconds(), store.Stamp(now)
	}
	giveUp := func(reason string) (string, error) {
		ms, now := stamp()
		return reason, s.st.SaveReauthFailure(ctx, secret.UUID(), o.Owner, store.StatusReauthRequired, reason, true, 0, ms, now)
	}

	var creds storedLogin
	if o.ReauthCiphertext == nil || s.box.Open(*o.ReauthCiphertext, &creds) != nil || creds.Username == "" || creds.Password == "" {
		return giveUp("invalid_credentials")
	}
	up, err := s.brp.Login(ctx, creds.Username, creds.Password)
	if errors.Is(err, brp.ErrInvalidCredentials) {
		return giveUp("credentials_rejected")
	}
	if err != nil {
		log.Printf("scheduled reauthorization: login: %v", err)
		ms, now := stamp()
		retryAt := s.now().Add(reauthRetry).UnixMilli()
		return "reauth_failed", s.st.SaveReauthFailure(ctx, secret.UUID(), o.Owner, store.StatusRefreshFailed, "reauth_failed", false, retryAt, ms, now)
	}
	if s.box.OwnerID(up.CustomerID) != o.Owner {
		return giveUp("owner_mismatch")
	}
	sealed, err := s.box.Seal(up)
	if err != nil {
		return "seal_failed", err
	}
	ms, now := stamp()
	next := nextReauthAt(s.now().UnixMilli(), up.ExpiresAt)
	return store.StatusHealthy, s.st.SaveReauthSuccess(ctx, secret.UUID(), o.Owner, sealed, up.ExpiresAt, next, ms, now)
}
