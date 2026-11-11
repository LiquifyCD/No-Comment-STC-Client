package web

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

// storedLogin is the sealed login kept for automatic renewal.
type storedLogin struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// credentials reads username and password from a login body.
func credentials(v any) (storedLogin, bool) {
	body, _ := v.(map[string]any)
	username, _ := body["username"].(string)
	password, _ := body["password"].(string)
	username = strings.TrimSpace(username)
	if username == "" || len(username) > 254 || password == "" || len(password) > 256 {
		return storedLogin{}, false
	}
	return storedLogin{username, password}, true
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(r) {
		writeErr(w, http.StatusForbidden, "Otillåtet ursprung.")
		return
	}
	body, _ := readJSON(w, r, maxOpenBody)
	in, ok := credentials(body)
	if !ok {
		writeErr(w, http.StatusBadRequest, "Användarnamn och lösenord krävs.")
		return
	}
	ctx := r.Context()
	up, err := s.upstreamLogin(r, in.Username, in.Password)
	var upstream *brp.UpstreamError
	switch {
	case errors.Is(err, errThrottled):
		writeErr(w, http.StatusTooManyRequests, "För många inloggningsförsök. Försök igen senare.")
		return
	case errors.Is(err, brp.ErrInvalidCredentials):
		writeErr(w, http.StatusUnauthorized, "Fel användarnamn eller lösenord.")
		return
	case errors.As(err, &upstream) && upstream.Op == "app configuration":
		writeErr(w, http.StatusBadGateway, "BRP-konfigurationen kunde inte hämtas.")
		return
	case err != nil:
		log.Printf("login: %v", err)
		writeErr(w, http.StatusBadGateway, "Inloggningen misslyckades.")
		return
	}

	now := s.now()
	stamp := store.Stamp(now)
	owner := s.box.OwnerID(up.CustomerID)
	sealed, err := s.box.Seal(up)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.st.UpsertOwnerSession(ctx, secret.UUID(), owner, sealed, up.ExpiresAt, "login", stamp); err != nil {
		s.fail(w, r, err)
		return
	}
	// With automatic renewal on, a manual login also refreshes the stored
	// login, so a changed password is picked up.
	if o, err := s.st.OwnerSession(ctx, owner); err == nil && o.ReauthEnabled {
		creds, err := s.box.Seal(in)
		if err == nil {
			err = s.st.RefreshReauthLogin(ctx, owner, creds, nextReauthAt(now.UnixMilli(), up.ExpiresAt), stamp)
		}
		if err != nil {
			s.fail(w, r, err)
			return
		}
	}
	id := secret.Token(32)
	ttl := sessionTTL(now.UnixMilli(), up.ExpiresAt)
	if err := s.st.CreateBrowserSession(ctx, secret.SessionKey(id), owner, sealed, now.UnixMilli()+int64(ttl)*1000, stamp); err != nil {
		s.fail(w, r, err)
		return
	}
	setSessionCookie(w, id, ttl)
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	a, err := s.active(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if a == nil {
		writeJSON(w, http.StatusOK, map[string]bool{"authenticated": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated":  true,
		"expiresAt":      stampMs(a.upstream.ExpiresAt),
		"csrfToken":      s.box.CSRF(a.id),
		"passageEnabled": s.cfg.PassageEnabled,
	})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	a, err := s.active(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if a != nil {
		if p := s.checkMutation(r, a); p != nil {
			writeProblem(w, p)
			return
		}
		if err := s.st.DeleteBrowserSession(r.Context(), a.key); err != nil {
			s.fail(w, r, err)
			return
		}
		setSessionCookie(w, "", -1)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": false})
}

// enableReauth stores the owner's login, sealed, so the upstream session
// device credentials use is renewed before it expires.
func (s *Server) enableReauth(w http.ResponseWriter, r *http.Request, a *active) {
	if r.ContentLength > maxOpenBody {
		writeErr(w, http.StatusRequestEntityTooLarge, "Invalid request.")
		return
	}
	body, err := readJSON(w, r, maxOpenBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Invalid request.")
		return
	}
	in, ok := credentials(body)
	if !ok {
		writeErr(w, http.StatusBadRequest, "Email and password are required.")
		return
	}
	ctx := r.Context()
	started := s.now()
	up, err := s.upstreamLogin(r, in.Username, in.Password)
	if errors.Is(err, errThrottled) {
		writeErr(w, http.StatusTooManyRequests, "Too many attempts. Try again later.")
		return
	}
	if errors.Is(err, brp.ErrInvalidCredentials) {
		writeErr(w, http.StatusUnauthorized, "Invalid email or password.")
		return
	}
	if err != nil {
		log.Printf("scheduled reauth login: %v", err)
		writeErr(w, http.StatusBadGateway, "Reauthorization failed.")
		return
	}
	if s.box.OwnerID(up.CustomerID) != a.owner {
		writeErr(w, http.StatusForbidden, "The account does not match the signed-in owner.")
		return
	}
	sealed, err := s.box.Seal(up)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	creds, err := s.box.Seal(in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	now := s.now()
	stamp := store.Stamp(now)
	next := nextReauthAt(now.UnixMilli(), up.ExpiresAt)
	if err := s.st.EnableReauth(ctx, secret.UUID(), a.owner, sealed, up.ExpiresAt, creds, next, now.Sub(started).Milliseconds(), stamp); err != nil {
		s.fail(w, r, err)
		return
	}
	ttl := sessionTTL(now.UnixMilli(), up.ExpiresAt)
	if err := s.st.UpdateBrowserSession(ctx, a.key, sealed, now.UnixMilli()+int64(ttl)*1000); err != nil {
		s.fail(w, r, err)
		return
	}
	setSessionCookie(w, a.id, ttl)
	writeJSON(w, http.StatusOK, map[string]any{"scheduledReauthEnabled": true, "nextReauthAt": stampMs(next), "lastReauthAt": stamp})
}

func (s *Server) disableReauth(w http.ResponseWriter, r *http.Request, a *active) {
	if err := s.st.DisableReauth(r.Context(), secret.UUID(), a.owner, store.Stamp(s.now())); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scheduledReauthEnabled": false, "nextReauthAt": nil})
}
