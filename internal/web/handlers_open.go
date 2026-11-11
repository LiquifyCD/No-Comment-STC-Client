package web

import (
	"context"
	"errors"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

// stopwatch times the stages of an open-door request for the log, and notes
// what each request to BRP spent on its connection and on waiting for BRP.
type stopwatch struct {
	now         func() time.Time
	start, last time.Time
	stages      map[string]int64

	mu       sync.Mutex // doors opened together report at the same time
	upstream []brp.ConnStats
}

func newStopwatch(now func() time.Time) *stopwatch {
	t := now()
	return &stopwatch{now: now, start: t, last: t, stages: map[string]int64{}, upstream: []brp.ConnStats{}}
}

func (t *stopwatch) upstreamCall(stats brp.ConnStats) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.upstream = append(t.upstream, stats)
}

func (t *stopwatch) mark(stage string) {
	n := t.now()
	t.stages[stage] = n.Sub(t.last).Milliseconds()
	t.last = n
}

func errorBody(msg string) map[string]any { return map[string]any{"error": msg} }

// bearerCredential reads a device credential from the Authorization header.
func bearerCredential(r *http.Request) (id, deviceSecret string, ok bool) {
	scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "Bearer") {
		return "", "", false
	}
	return parseCredential(strings.TrimSpace(token))
}

// openDoor is the API for automations: one request opens a named door or
// runs a named sequence. A device credential is the normal way in; the
// email+password form exists only when a legacy API key is configured.
func (s *Server) openDoor(w http.ResponseWriter, r *http.Request) {
	watch := newStopwatch(s.now)
	id, deviceSecret, isDevice := bearerCredential(r)
	mode := "legacy"
	if isDevice {
		mode = "device"
	}
	r = r.WithContext(brp.WithConnStats(r.Context(), watch.upstreamCall))
	status, payload := s.handleOpen(w, r, watch, id, deviceSecret, isDevice)
	logEvent("open_door_timing", map[string]any{
		"mode": mode, "status": status, "ok": status == http.StatusOK,
		"totalMs": s.now().Sub(watch.start).Milliseconds(), "stages": watch.stages, "upstream": watch.upstream,
	})
	writeJSON(w, status, payload)
}

func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request, watch *stopwatch, id, deviceSecret string, isDevice bool) (int, any) {
	if r.ContentLength > maxOpenBody {
		return http.StatusRequestEntityTooLarge, errorBody("Invalid request.")
	}
	body, err := readJSON(w, r, maxOpenBody)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return http.StatusRequestEntityTooLarge, errorBody("Invalid request.")
		}
		return http.StatusBadRequest, errorBody("Invalid request.")
	}
	if !s.cfg.PassageEnabled {
		return http.StatusServiceUnavailable, errorBody("Door opening is disabled.")
	}
	if s.foreignOrigin(r) {
		return http.StatusForbidden, errorBody("Forbidden.")
	}
	if isDevice {
		return s.openWithDevice(r.Context(), watch, id, deviceSecret, body)
	}
	return s.openWithLogin(r, watch, body)
}

func internalError(err error) (int, any) {
	log.Printf("open-door: %v", err)
	return http.StatusInternalServerError, errorBody(unexpected)
}

func (s *Server) openWithDevice(ctx context.Context, watch *stopwatch, id, deviceSecret string, body any) (int, any) {
	now := s.now()
	d, err := s.st.Device(ctx, id)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return internalError(err)
	}
	// Hash the presented secret whether or not the device exists, so both
	// cases cost the same.
	matches := secret.Equal(d.TokenHash, s.box.TokenHash(deviceSecret))
	if err != nil || !matches || d.RevokedAt != nil || d.ExpiresAt <= now.UnixMilli() {
		return http.StatusUnauthorized, errorBody("Invalid or expired device credential.")
	}
	if !s.gates.acquire("device:"+d.ID, doorCooldown, now) {
		return http.StatusTooManyRequests, errorBody("Wait 1 second before retrying.")
	}
	ref, p := validateDeviceTarget(body)
	if p != nil {
		return p.status, errorBody(p.msg)
	}
	o, err := s.st.OwnerSession(ctx, d.Owner)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return internalError(err)
	}
	var up brp.Session
	if err != nil || o.Status == store.StatusReauthRequired || o.UpstreamExpiresAt <= now.UnixMilli() || s.box.Open(o.Ciphertext, &up) != nil {
		return http.StatusUnauthorized, errorBody("Device session needs reauthorization.")
	}
	watch.mark("auth")

	targetID, steps, p, err := s.resolveTarget(ctx, d.Owner, ref)
	if err != nil {
		return internalError(err)
	}
	if p != nil {
		return p.status, errorBody(p.msg)
	}
	allowed, err := s.st.DeviceTargetIDs(ctx, d.ID)
	if err != nil {
		return internalError(err)
	}
	if len(allowed) > 0 && !slices.Contains(allowed, targetID) {
		return http.StatusForbidden, errorBody("Target is not allowed for this device.")
	}
	watch.mark("target")

	res := s.runSteps(ctx, d.Owner, up, steps, "device_api_passage")
	watch.mark("passage")
	stamp := store.Stamp(s.now())
	if err := s.st.MarkDeviceUsed(context.WithoutCancel(ctx), secret.UUID(), d.Owner, d.ID, stamp); err != nil {
		log.Printf("open-door: mark device used: %v", err)
	}
	s.recordRun(ctx, ref.kind, targetID, d.Owner, res, stamp)
	return openResult(res, stamp)
}

// openWithLogin is the legacy form: the request carries the member's own
// login and a shared API key. Every attempt is rate limited before the key
// is even looked at.
func (s *Server) openWithLogin(r *http.Request, watch *stopwatch, body any) (int, any) {
	ctx := r.Context()
	if !s.gates.acquire("legacy:"+clientIP(r), doorCooldown, s.now()) {
		return http.StatusTooManyRequests, errorBody("Try again in 1 second.")
	}
	if s.cfg.LegacyAPIKey == "" || !secret.Equal(r.Header.Get("X-Api-Key"), s.cfg.LegacyAPIKey) {
		return http.StatusUnauthorized, errorBody("Unauthorized.")
	}
	in, p := validateLegacyOpen(body)
	if p != nil {
		return p.status, errorBody(p.msg)
	}
	up, err := s.upstreamLogin(r, in.email, in.password)
	if errors.Is(err, errThrottled) {
		return http.StatusTooManyRequests, errorBody("Try again later.")
	}
	if errors.Is(err, brp.ErrInvalidCredentials) {
		return http.StatusUnauthorized, errorBody("Invalid credentials.")
	}
	if err != nil {
		log.Printf("open-door: login: %v", err)
		return http.StatusBadGateway, errorBody("Request failed.")
	}
	watch.mark("auth")

	owner := s.box.OwnerID(up.CustomerID)
	targetID, steps, p, err := s.resolveTarget(ctx, owner, in.target)
	if err != nil {
		return internalError(err)
	}
	if p != nil {
		return p.status, errorBody(p.msg)
	}
	watch.mark("target")

	res := s.runSteps(ctx, owner, up, steps, "api_passage")
	watch.mark("passage")
	stamp := store.Stamp(s.now())
	s.recordRun(ctx, in.target.kind, targetID, owner, res, stamp)
	return openResult(res, stamp)
}

func openResult(res outcome, stamp string) (int, any) {
	if !res.ok {
		return res.status, map[string]any{"error": res.msg, "failedStep": res.failedStep, "completedSteps": res.completed}
	}
	return http.StatusOK, map[string]any{"ok": true, "message": "Request completed.", "completedSteps": res.completed, "timestamp": stamp}
}
