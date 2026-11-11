package web

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

// active is the signed-in browser behind a request.
type active struct {
	id       string // the cookie value
	key      string // what the session is stored under
	owner    string
	upstream brp.Session
}

type handler func(http.ResponseWriter, *http.Request, *active)

// active returns the request's browser session, or nil when signed out.
func (s *Server) active(r *http.Request) (*active, error) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil, nil
	}
	key := secret.SessionKey(c.Value)
	row, err := s.st.BrowserSession(r.Context(), key, s.now().UnixMilli())
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a := &active{id: c.Value, key: key, owner: row.Owner}
	if err := s.box.Open(row.Ciphertext, &a.upstream); err != nil {
		return nil, nil // sealed under another key: signed out
	}
	return a, nil
}

// signedIn admits only requests with a browser session.
func (s *Server) signedIn(next handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if id := r.PathValue("id"); id != "" && !idPattern.MatchString(id) {
			notFound(w, r)
			return
		}
		a, err := s.active(r)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if a == nil {
			writeErr(w, http.StatusUnauthorized, "Inte inloggad.")
			return
		}
		next(w, r, a)
	}
}

// mutation additionally requires a same-origin request carrying the
// session's CSRF token.
func (s *Server) mutation(next handler) http.HandlerFunc {
	return s.signedIn(func(w http.ResponseWriter, r *http.Request, a *active) {
		if p := s.checkMutation(r, a); p != nil {
			writeProblem(w, p)
			return
		}
		next(w, r, a)
	})
}

func (s *Server) checkMutation(r *http.Request, a *active) *problem {
	if !s.sameOrigin(r) {
		return &problem{http.StatusForbidden, "Otillåtet ursprung."}
	}
	if !secret.Equal(r.Header.Get("X-Csrf-Token"), s.box.CSRF(a.id)) {
		return &problem{http.StatusForbidden, "Ogiltig CSRF-token."}
	}
	return nil
}

// originAllowed reports whether an Origin header names this app: one of the
// configured origins, or with none configured, the host the request reached.
func (s *Server) originAllowed(origin string, r *http.Request) bool {
	for _, o := range s.cfg.Origins {
		if strings.EqualFold(origin, o) {
			return true
		}
	}
	if len(s.cfg.Origins) > 0 {
		return false
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host != "" && strings.EqualFold(u.Host, r.Host)
}

// sameOrigin is the check for browser writes: the request must say where it
// comes from, and that must be this app.
func (s *Server) sameOrigin(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "cross-site", "same-site":
		return false
	}
	origin := r.Header.Get("Origin")
	return origin != "" && s.originAllowed(origin, r)
}

// foreignOrigin is the check for the open-door API, which is called by
// scripts that send no Origin: only a browser on another site is refused.
func (s *Server) foreignOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin != "" && !s.originAllowed(origin, r)
}

// clientIP is the caller's address. The app listens on loopback behind
// `tailscale serve`, which appends the real client to X-Forwarded-For, so
// the last entry is the one the proxy vouches for.
func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// sessionTTL is how long a browser session lasts: as long as the upstream
// session, within one minute to seven days.
func sessionTTL(nowMs, upstreamExpiresAt int64) int {
	seconds := (upstreamExpiresAt - nowMs + 999) / 1000
	return int(min(max(seconds, minSessionSeconds), maxSessionSeconds))
}

func setSessionCookie(w http.ResponseWriter, id string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    id,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

// loginKeys are the throttle buckets for one login attempt.
func loginKeys(r *http.Request, username string) (client, user string) {
	ip := clientIP(r)
	return "client|" + ip, "user|" + ip + "|" + strings.ToLower(username)
}

// errThrottled means this client has used up its wrong passwords for now.
var errThrottled = errors.New("too many login attempts")

// upstreamLogin logs in to BRP for a client. The attempt is counted before
// BRP is asked, and stays counted when BRP turns the login down.
func (s *Server) upstreamLogin(r *http.Request, username, password string) (brp.Session, error) {
	client, user := loginKeys(r, username)
	now := s.now()
	if !s.logins.take(client, loginClientLimit, now) {
		return brp.Session{}, errThrottled
	}
	if !s.logins.take(user, loginUserLimit, now) {
		s.logins.release(client)
		return brp.Session{}, errThrottled
	}
	up, err := s.brp.Login(r.Context(), username, password)
	var upstream *brp.UpstreamError
	switch {
	case err == nil:
		s.logins.release(client)
		s.logins.clear(user)
	case errors.Is(err, brp.ErrInvalidCredentials):
	case errors.As(err, &upstream) && upstream.Op == "login" && upstream.Status < http.StatusInternalServerError:
		// BRP refused the login in some other way; still a guess.
	default:
		s.logins.release(client)
		s.logins.release(user)
	}
	return up, err
}
