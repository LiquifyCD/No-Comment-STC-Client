package web

import (
	"errors"
	"net/http"
	"time"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

const deviceNotFound = "Device not found."

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request, a *active) {
	ctx := r.Context()
	o, err := s.st.OwnerSession(ctx, a.owner)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, err)
		return
	}
	shared := viewOwnerSession(o, err == nil, s.now().UnixMilli())
	devices, err := s.st.Devices(ctx, a.owner)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := []deviceView{}
	for _, d := range devices {
		out = append(out, viewDevice(d, shared))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ownerSession": shared, "devices": out})
}

// newCredential makes a device secret and the credential that carries it.
func newCredential(deviceID string) (deviceSecret, credential string) {
	deviceSecret = secret.Token(32)
	return deviceSecret, "brpd_" + deviceID + "." + deviceSecret
}

func (s *Server) createDevice(w http.ResponseWriter, r *http.Request, a *active) {
	body, err := readJSON(w, r, maxBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Invalid request.")
		return
	}
	in, p := validateDevice(body)
	if p != nil {
		writeProblem(w, p)
		return
	}
	ctx := r.Context()
	for _, target := range in.targets {
		owned, err := s.st.OwnsTarget(ctx, a.owner, target.Type, target.ID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if !owned {
			writeErr(w, http.StatusBadRequest, "Invalid target allowlist.")
			return
		}
	}
	now := s.now()
	d := store.Device{ID: secret.UUID(), Owner: a.owner, Name: in.name, ExpiresAt: store.NeverExpires, Targets: in.targets}
	if !in.never {
		d.ExpiresAt = now.Add(time.Duration(in.days) * 24 * time.Hour).UnixMilli()
	}
	deviceSecret, credential := newCredential(d.ID)
	d.TokenHash = s.box.TokenHash(deviceSecret)
	err = s.st.CreateDevice(ctx, secret.UUID(), d, nameKey(in.name), store.Stamp(now))
	if errors.Is(err, store.ErrConflict) {
		writeErr(w, http.StatusConflict, "A device with that name already exists.")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"device":     map[string]any{"id": d.ID, "name": d.Name, "expiresAt": deviceExpiry(d.ExpiresAt)},
		"credential": credential,
	})
}

// deviceChanged writes the response of a device mutation.
func (s *Server) deviceChanged(w http.ResponseWriter, r *http.Request, err error, payload any) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, deviceNotFound)
	case errors.Is(err, store.ErrConflict):
		writeErr(w, http.StatusConflict, "A device with that name already exists.")
	case err != nil:
		s.fail(w, r, err)
	default:
		writeJSON(w, http.StatusOK, payload)
	}
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request, a *active) {
	err := s.st.RevokeDevice(r.Context(), secret.UUID(), a.owner, r.PathValue("id"), store.Stamp(s.now()))
	s.deviceChanged(w, r, err, map[string]bool{"revoked": true})
}

// rotateDevice replaces a credential's secret; the old one stops working.
func (s *Server) rotateDevice(w http.ResponseWriter, r *http.Request, a *active) {
	id := r.PathValue("id")
	deviceSecret, credential := newCredential(id)
	err := s.st.RotateDevice(r.Context(), secret.UUID(), a.owner, id, s.box.TokenHash(deviceSecret), store.Stamp(s.now()))
	s.deviceChanged(w, r, err, map[string]string{"credential": credential})
}

func (s *Server) renameDevice(w http.ResponseWriter, r *http.Request, a *active) {
	body, err := readJSON(w, r, maxBody)
	fields, isObject := body.(map[string]any)
	if err != nil || !isObject {
		writeErr(w, http.StatusBadRequest, "Invalid request.")
		return
	}
	name := normalize(fields["name"])
	if !namePattern.MatchString(name) {
		writeErr(w, http.StatusBadRequest, "Invalid device name.")
		return
	}
	id := r.PathValue("id")
	err = s.st.RenameDevice(r.Context(), secret.UUID(), a.owner, id, name, nameKey(name), store.Stamp(s.now()))
	s.deviceChanged(w, r, err, map[string]any{"device": map[string]string{"id": id, "name": name}})
}

// reauthorizeDevice hands the signed-in browser's upstream session to the
// owner's device credentials.
func (s *Server) reauthorizeDevice(w http.ResponseWriter, r *http.Request, a *active) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := s.st.OwnedDevice(ctx, a.owner, id); err != nil {
		s.deviceChanged(w, r, err, nil)
		return
	}
	o, err := s.st.OwnerSession(ctx, a.owner)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, err)
		return
	}
	stamp := store.Stamp(s.now())
	// A session renewed since this browser signed in outlives the browser's
	// own; keep it.
	if err != nil || o.Status != store.StatusHealthy || o.UpstreamExpiresAt < a.upstream.ExpiresAt {
		sealed, err := s.box.Seal(a.upstream)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if err := s.st.UpsertOwnerSession(ctx, secret.UUID(), a.owner, sealed, a.upstream.ExpiresAt, "reauthorize", stamp); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	err = s.st.NoteDevice(ctx, secret.UUID(), a.owner, id, "reauthorize", stamp)
	s.deviceChanged(w, r, err, map[string]bool{"reauthorized": true})
}
