// Package web serves the STC client's JSON API and embedded PWA.
//
// It listens on loopback behind `tailscale serve`, which terminates TLS. The
// app authenticates every caller itself (a BRP login per browser, a device
// credential per automation), so it does not depend on the tailnet for
// access control.
package web

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

//go:embed static
var staticFS embed.FS

const (
	maxBody           = 64 << 10 // browser API requests
	maxOpenBody       = 2048     // open-door and renewal requests
	sessionCookie     = "brp_session"
	minSessionSeconds = 60
	maxSessionSeconds = 7 * 24 * 60 * 60
	doorCooldown      = time.Second
	replayWindow      = 5 * time.Minute
	loginWindow       = 15 * time.Minute
	loginUserLimit    = 5  // wrong passwords per client and username
	loginClientLimit  = 20 // wrong passwords per client
	unexpected        = "Ett oväntat fel inträffade."
)

// Config is the deployment policy.
type Config struct {
	Origins        []string // browser origins of this app, e.g. https://stc.example.ts.net:10000
	PassageEnabled bool     // false refuses every door request
	DefaultReader  int      // BRP reader code seeded as "Main entrance"; 0 seeds nothing
	LegacyAPIKey   string   // enables email+password open-door requests; "" turns them off
}

// Server is the web application.
type Server struct {
	st     *store.Store
	box    *secret.Box
	brp    *brp.Client
	cfg    Config
	now    func() time.Time
	sleep  func(context.Context, time.Duration) error
	gates  *gate
	logins *throttle

	codesMu sync.Mutex
	codes   map[string]int // door id → BRP card reader, so a door costs one upstream call
}

// New builds the application.
func New(st *store.Store, box *secret.Box, client *brp.Client, cfg Config) *Server {
	return &Server{
		st:     st,
		box:    box,
		brp:    client,
		cfg:    cfg,
		now:    time.Now,
		sleep:  sleep,
		gates:  newGate(),
		logins: newThrottle(loginWindow),
		codes:  map[string]int{},
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Handler builds the HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)

	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", s.logout)
	mux.HandleFunc("GET /api/session", s.session)
	mux.HandleFunc("POST /api/scheduled-reauth", s.mutation(s.enableReauth))
	mux.HandleFunc("DELETE /api/scheduled-reauth", s.mutation(s.disableReauth))

	mux.HandleFunc("POST /api/open-door", s.openDoor)

	mux.HandleFunc("GET /api/readers", s.signedIn(s.listReaders))
	mux.HandleFunc("POST /api/readers", s.mutation(s.createReader))
	mux.HandleFunc("GET /api/readers/{id}", s.signedIn(s.getReader))
	mux.HandleFunc("PATCH /api/readers/{id}", s.mutation(s.renameReader))
	mux.HandleFunc("DELETE /api/readers/{id}", s.mutation(s.deleteReader))
	mux.HandleFunc("POST /api/readers/{id}/door", s.mutation(s.passage))
	mux.HandleFunc("POST /api/readers/{id}/passage", s.mutation(s.passage))

	mux.HandleFunc("GET /api/sequences", s.signedIn(s.listSequences))
	mux.HandleFunc("POST /api/sequences", s.mutation(s.saveSequence))
	mux.HandleFunc("PATCH /api/sequences/{id}", s.mutation(s.saveSequence))
	mux.HandleFunc("DELETE /api/sequences/{id}", s.mutation(s.deleteSequence))
	mux.HandleFunc("POST /api/sequences/{id}/run", s.mutation(s.runSequence))
	mux.HandleFunc("GET /api/default", s.signedIn(s.getDefault))
	mux.HandleFunc("PUT /api/default", s.mutation(s.putDefault))

	mux.HandleFunc("GET /api/device-sessions", s.signedIn(s.listDevices))
	mux.HandleFunc("POST /api/device-sessions", s.mutation(s.createDevice))
	mux.HandleFunc("PATCH /api/device-sessions/{id}", s.mutation(s.renameDevice))
	mux.HandleFunc("DELETE /api/device-sessions/{id}", s.mutation(s.revokeDevice))
	mux.HandleFunc("POST /api/device-sessions/{id}/rotate", s.mutation(s.rotateDevice))
	mux.HandleFunc("POST /api/device-sessions/{id}/reauthorize", s.mutation(s.reauthorizeDevice))

	mux.HandleFunc("/api/", notFound)
	mux.Handle("/", staticHandler())
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if err := s.st.Ping(r.Context()); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeErr(w, http.StatusNotFound, "Not found")
}

// --- static ---

func staticHandler() http.Handler {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(sub)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if info, err := fs.Stat(sub, p); err != nil || info.IsDir() {
			p = "index.html" // client-side routes get the shell
		}
		// Embedded files have no mod time; always revalidate so a deploy is
		// picked up (the service worker covers offline).
		w.Header().Set("Cache-Control", "no-cache")
		if strings.HasSuffix(p, ".webmanifest") {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + p
		if p == "index.html" {
			r2.URL.Path = "/" // FileServer redirects /index.html → /
		}
		files.ServeHTTP(w, r2)
	})
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeProblem(w http.ResponseWriter, p *problem) { writeErr(w, p.status, p.msg) }

// fail reports an error the client cannot do anything about.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) {
		return
	}
	log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
	writeErr(w, http.StatusInternalServerError, unexpected)
}

// readJSON decodes a request body of at most limit bytes into generic JSON,
// so the validators can refuse fields a client must not send.
func readJSON(w http.ResponseWriter, r *http.Request, limit int64) (any, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		return nil, err
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return v, nil
}

// logEvent writes one structured log line.
func logEvent(event string, fields map[string]any) {
	fields["event"] = event
	raw, err := json.Marshal(fields)
	if err != nil {
		return
	}
	log.Print(string(raw))
}
