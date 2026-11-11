package web

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

const (
	testOrigin = "https://stc.test"
	evilOrigin = "https://evil.example"
	anna       = "anna@example.com"
	annaPass   = "hunter2"
	bo         = "bo@example.com"
	boPass     = "letmein"
	week       = 7 * 24 * time.Hour
)

// fakeBRP stands in for the upstream. Tests never talk to the real one.
type fakeBRP struct {
	mu            sync.Mutex
	passwords     map[string]string
	customers     map[string]string
	loginStatus   int // when set, every login answers this
	passageStatus int // when set, every passage answers this
	rejectReader  int // a card reader BRP refuses
	logins        int
	lookups       int
	opened        []int  // card readers of passage requests, in order
	passageWait   func() // when set, every passage request waits in it first
}

func (f *fakeBRP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/passagetries") {
		f.mu.Lock()
		wait := f.passageWait
		f.mu.Unlock()
		if wait != nil {
			wait()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.URL.Path == "/apps/383":
		w.Header().Set("Set-Cookie", "lb=one; Path=/")
		_, _ = w.Write([]byte(`{}`))
	case r.URL.Path == "/auth/login":
		f.logins++
		var in struct{ Username, Password string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		switch {
		case f.loginStatus != 0:
			w.WriteHeader(f.loginStatus)
		case in.Password == "" || f.passwords[in.Username] != in.Password:
			w.WriteHeader(http.StatusUnauthorized)
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "token", "username": f.customers[in.Username], "expires_in": int(week.Seconds())})
		}
	case r.URL.Path == "/passagereaders":
		f.lookups++
		minor, _ := strconv.Atoi(r.URL.Query().Get("minor"))
		if minor == 404 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]int{"id": 1000 + minor})
	case strings.HasSuffix(r.URL.Path, "/passagetries"):
		var in struct{ CardReader int }
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.opened = append(f.opened, in.CardReader)
		switch {
		case f.passageStatus != 0:
			w.WriteHeader(f.passageStatus)
		case in.CardReader == f.rejectReader:
			w.WriteHeader(http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusCreated)
		}
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeBRP) set(change func(*fakeBRP)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func (f *fakeBRP) counts() (logins, lookups int, opened []int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.logins, f.lookups, append([]int(nil), f.opened...)
}

type app struct {
	t     *testing.T
	srv   *Server
	h     http.Handler
	brp   *fakeBRP
	mu    sync.Mutex
	now   time.Time
	slept []time.Duration
}

func newApp(t *testing.T, cfg Config) *app {
	t.Helper()
	fake := &fakeBRP{
		passwords: map[string]string{anna: annaPass, bo: boPass},
		customers: map[string]string{anna: "1001", bo: "2002"},
	}
	upstream := httptest.NewServer(fake)
	t.Cleanup(upstream.Close)
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "stc.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, err := secret.New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	a := &app{t: t, brp: fake, now: time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)}
	client := brp.New(upstream.URL, "383")
	client.Now = a.clock
	cfg.Origins = []string{testOrigin}
	a.srv = New(st, box, client, cfg)
	a.srv.now = a.clock
	a.srv.sleep = func(_ context.Context, d time.Duration) error {
		a.slept = append(a.slept, d)
		return nil
	}
	a.h = a.srv.Handler()
	return a
}

func (a *app) clock() time.Time {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.now
}

func (a *app) advance(d time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.now = a.now.Add(d)
}

type reply struct {
	status int
	header http.Header
	raw    string
	body   map[string]any
}

type mod func(*http.Request)

func header(key, value string) mod { return func(r *http.Request) { r.Header.Set(key, value) } }

func noOrigin(r *http.Request) { r.Header.Del("Origin") }

// send runs one request through the handler.
func (a *app) send(method, target string, body any, mods ...mod) reply {
	a.t.Helper()
	var payload io.Reader
	switch v := body.(type) {
	case nil:
	case string:
		payload = strings.NewReader(v)
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			a.t.Fatal(err)
		}
		payload = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, target, payload)
	req.Host = "stc.test"
	for _, m := range mods {
		m(req)
	}
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	out := reply{status: rec.Code, header: rec.Header(), raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.body)
	return out
}

// browser is a signed-in (or anonymous) browser on the app's own origin.
type browser struct {
	app          *app
	cookie, csrf string
}

func (b *browser) call(method, target string, body any, mods ...mod) reply {
	b.app.t.Helper()
	base := []mod{header("Origin", testOrigin)}
	if b.cookie != "" {
		base = append(base, header("Cookie", sessionCookie+"="+b.cookie))
	}
	if b.csrf != "" {
		base = append(base, header("X-Csrf-Token", b.csrf))
	}
	return b.app.send(method, target, body, append(base, mods...)...)
}

func (a *app) signIn(username, password string) *browser {
	a.t.Helper()
	b := &browser{app: a}
	res := b.call("POST", "/api/login", map[string]string{"username": username, "password": password})
	if res.status != http.StatusOK {
		a.t.Fatalf("login: %d %s", res.status, res.raw)
	}
	for _, c := range (&http.Response{Header: res.header}).Cookies() {
		if c.Name == sessionCookie {
			b.cookie = c.Value
		}
	}
	b.csrf, _ = b.call("GET", "/api/session", nil).body["csrfToken"].(string)
	if b.cookie == "" || b.csrf == "" {
		a.t.Fatal("login gave no session")
	}
	return b
}

func (b *browser) createDoor(name, major, minor string) string {
	b.app.t.Helper()
	res := b.call("POST", "/api/readers", map[string]string{"name": name, "major": major, "minor": minor})
	want(b.app.t, res, http.StatusCreated, "")
	return res.body["reader"].(map[string]any)["id"].(string)
}

func (b *browser) pass(doorID, requestID string) reply {
	b.app.t.Helper()
	return b.call("POST", "/api/readers/"+doorID+"/passage", map[string]any{"confirmed": true, "requestId": requestID})
}

// open calls the automation API the way a script does: no Origin, no cookie.
func (a *app) open(credential string, body any, mods ...mod) reply {
	a.t.Helper()
	return a.send("POST", "/api/open-door", body, append([]mod{header("Authorization", "Bearer "+credential)}, mods...)...)
}

// want checks a reply's status and, when msg is set, its error message.
func want(t *testing.T, res reply, status int, msg string) {
	t.Helper()
	if res.status != status {
		t.Fatalf("status = %d, want %d (%s)", res.status, status, res.raw)
	}
	if got, _ := res.body["error"].(string); msg != "" && got != msg {
		t.Fatalf("error = %q, want %q", got, msg)
	}
}

func TestLoginGivesAHardenedSession(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	anon := &browser{app: a}
	if res := anon.call("GET", "/api/session", nil); res.body["authenticated"] != false {
		t.Fatalf("anonymous session = %s", res.raw)
	}
	want(t, anon.call("GET", "/api/readers", nil), http.StatusUnauthorized, "Inte inloggad.")
	want(t, anon.call("POST", "/api/login", map[string]string{"username": anna}), http.StatusBadRequest, "Användarnamn och lösenord krävs.")
	want(t, anon.call("POST", "/api/login", "{"), http.StatusBadRequest, "Användarnamn och lösenord krävs.")

	res := anon.call("POST", "/api/login", map[string]string{"username": anna, "password": annaPass})
	want(t, res, http.StatusOK, "")
	cookie := res.header.Get("Set-Cookie")
	for _, attr := range []string{sessionCookie + "=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=604800"} {
		if !strings.Contains(cookie, attr) {
			t.Errorf("cookie %q lacks %s", cookie, attr)
		}
	}

	b := a.signIn(anna, annaPass)
	session := b.call("GET", "/api/session", nil)
	if session.body["authenticated"] != true || session.body["passageEnabled"] != true || session.body["expiresAt"] != "2026-10-11T12:00:00.000Z" {
		t.Fatalf("session = %s", session.raw)
	}

	want(t, b.call("POST", "/api/logout", nil), http.StatusOK, "")
	want(t, b.call("GET", "/api/readers", nil), http.StatusUnauthorized, "Inte inloggad.")
	if res := anon.call("POST", "/api/logout", nil); res.status != http.StatusOK || res.body["authenticated"] != false {
		t.Fatalf("anonymous logout = %d %s", res.status, res.raw)
	}
}

func TestSessionExpiresWithTheUpstreamSession(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	a.advance(week + time.Minute)
	want(t, b.call("GET", "/api/readers", nil), http.StatusUnauthorized, "Inte inloggad.")
	a.srv.maintain(context.Background())
	if _, err := a.srv.st.BrowserSession(context.Background(), secret.SessionKey(b.cookie), 0); err != store.ErrNotFound {
		t.Fatalf("expired session was not purged: %v", err)
	}
}

func TestWritesNeedOwnOriginAndCSRFToken(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	other := a.signIn(bo, boPass)
	door := map[string]string{"name": "Gym", "major": "10", "minor": "1"}

	for name, m := range map[string]mod{
		"foreign origin":   header("Origin", evilOrigin),
		"no origin":        noOrigin,
		"cross-site fetch": header("Sec-Fetch-Site", "cross-site"),
	} {
		res := b.call("POST", "/api/readers", door, m)
		if res.status != http.StatusForbidden || res.body["error"] != "Otillåtet ursprung." {
			t.Errorf("%s: %d %s", name, res.status, res.raw)
		}
	}
	want(t, b.call("POST", "/api/readers", door, header("X-Csrf-Token", "wrong")), http.StatusForbidden, "Ogiltig CSRF-token.")
	want(t, b.call("POST", "/api/readers", door, header("X-Csrf-Token", other.csrf)), http.StatusForbidden, "Ogiltig CSRF-token.")
	want(t, b.call("POST", "/api/logout", nil, header("X-Csrf-Token", "wrong")), http.StatusForbidden, "Ogiltig CSRF-token.")

	login := map[string]string{"username": anna, "password": annaPass}
	anon := &browser{app: a}
	want(t, anon.call("POST", "/api/login", login, header("Origin", evilOrigin)), http.StatusForbidden, "Otillåtet ursprung.")
	want(t, anon.call("POST", "/api/login", login, noOrigin), http.StatusForbidden, "Otillåtet ursprung.")

	// With an origin configured, naming the right host is not enough.
	want(t, b.call("POST", "/api/readers", door, header("Origin", "http://stc.test")), http.StatusForbidden, "Otillåtet ursprung.")
	want(t, b.call("POST", "/api/readers", door), http.StatusCreated, "")

	// With none configured, the origin must name the host the request reached.
	a.srv.cfg.Origins = nil
	door["name"] = "Sauna"
	want(t, b.call("POST", "/api/readers", door, header("Origin", evilOrigin)), http.StatusForbidden, "Otillåtet ursprung.")
	want(t, b.call("POST", "/api/readers", door, header("Origin", "https://stc.test")), http.StatusCreated, "")
}

func TestLoginThrottlesPasswordGuessing(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	anon := &browser{app: a}
	guess := map[string]string{"username": anna, "password": "wrong"}
	for range loginUserLimit {
		want(t, anon.call("POST", "/api/login", guess), http.StatusUnauthorized, "Fel användarnamn eller lösenord.")
	}
	before, _, _ := a.brp.counts()
	want(t, anon.call("POST", "/api/login", guess), http.StatusTooManyRequests, "För många inloggningsförsök. Försök igen senare.")
	want(t, anon.call("POST", "/api/login", map[string]string{"username": anna, "password": annaPass}), http.StatusTooManyRequests, "")
	if after, _, _ := a.brp.counts(); after != before {
		t.Fatalf("blocked attempts reached BRP: %d → %d", before, after)
	}
	// Another client is not locked out by this one.
	elsewhere := header("X-Forwarded-For", "100.64.0.9")
	want(t, anon.call("POST", "/api/login", map[string]string{"username": anna, "password": annaPass}, elsewhere), http.StatusOK, "")

	a.advance(loginWindow + time.Second)
	want(t, anon.call("POST", "/api/login", map[string]string{"username": anna, "password": annaPass}), http.StatusOK, "")
}

func TestLoginReportsUpstreamTrouble(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	a.brp.set(func(f *fakeBRP) { f.loginStatus = http.StatusInternalServerError })
	anon := &browser{app: a}
	want(t, anon.call("POST", "/api/login", map[string]string{"username": anna, "password": annaPass}), http.StatusBadGateway, "Inloggningen misslyckades.")
}

func TestUnknownEndpointsAreNotFound(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	// The old Worker served every configured reader here, unauthenticated.
	want(t, a.send("GET", "/api/configured-readers", nil), http.StatusNotFound, "Not found")
	want(t, b.call("GET", "/api/configured-readers", nil), http.StatusNotFound, "Not found")
	want(t, b.call("GET", "/api/readers/not-an-id", nil), http.StatusNotFound, "Not found")
	want(t, b.call("DELETE", "/api/login", nil), http.StatusNotFound, "Not found")
}

func TestDoorLifecycle(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)

	for name, tc := range map[string]struct {
		body any
		msg  string
	}{
		"not an object":   {`[]`, "Ogiltig begäran."},
		"not json":        {`{`, "Ogiltig begäran."},
		"reader code":     {map[string]any{"name": "Gym", "major": "1", "minor": "2", "cardReader": 5}, "Readerkoden styrs av servern."},
		"no name":         {map[string]any{"name": " ", "major": "1", "minor": "2"}, "Ange ett namn."},
		"long name":       {map[string]any{"name": strings.Repeat("a", 41), "major": "1", "minor": "2"}, "Namnet får vara högst 40 tecken."},
		"markup":          {map[string]any{"name": "<b>", "major": "1", "minor": "2"}, "Namnet innehåller ogiltiga tecken."},
		"preset":          {map[string]any{"name": "Gym", "readerKey": "main"}, "Preset readers are not supported."},
		"numeric major":   {map[string]any{"name": "Gym", "major": 1, "minor": "2"}, "Ogiltig major."},
		"non-digit minor": {map[string]any{"name": "Gym", "major": "1", "minor": "x"}, "Ogiltig minor."},
	} {
		res := b.call("POST", "/api/readers", tc.body)
		if res.status != http.StatusBadRequest || res.body["error"] != tc.msg {
			t.Errorf("%s: %d %s", name, res.status, res.raw)
		}
	}

	created := b.call("POST", "/api/readers", map[string]string{"name": "  Gym   entré ", "major": "10", "minor": "7"})
	want(t, created, http.StatusCreated, "")
	reader := created.body["reader"].(map[string]any)
	id := reader["id"].(string)
	if reader["name"] != "Gym entré" {
		t.Fatalf("name = %v", reader["name"])
	}
	if strings.Contains(created.raw, `"major"`) {
		t.Fatalf("the beacon pair leaked: %s", created.raw)
	}
	want(t, b.call("POST", "/api/readers", map[string]string{"name": "GYM ENTRÉ", "major": "1", "minor": "2"}), http.StatusConflict, "En läsare med samma namn finns redan.")

	if readers := b.call("GET", "/api/readers", nil).body["readers"].([]any); len(readers) != 1 {
		t.Fatalf("readers = %v", readers)
	}
	want(t, b.call("PATCH", "/api/readers/"+id, map[string]string{"name": "Entré"}), http.StatusOK, "")
	want(t, b.call("PATCH", "/api/readers/"+id, map[string]string{"name": ""}), http.StatusBadRequest, "Ange ett namn.")
	detail := b.call("GET", "/api/readers/"+id, nil)
	if detail.body["reader"].(map[string]any)["name"] != "Entré" || len(detail.body["events"].([]any)) != 0 {
		t.Fatalf("detail = %s", detail.raw)
	}

	// Another account sees and can touch none of it.
	other := a.signIn(bo, boPass)
	if readers := other.call("GET", "/api/readers", nil).body["readers"].([]any); len(readers) != 0 {
		t.Fatalf("other owner sees %v", readers)
	}
	want(t, other.call("GET", "/api/readers/"+id, nil), http.StatusNotFound, "Läsaren hittades inte.")
	want(t, other.call("PATCH", "/api/readers/"+id, map[string]string{"name": "Mine"}), http.StatusNotFound, "Läsaren hittades inte.")
	want(t, other.call("DELETE", "/api/readers/"+id, map[string]bool{"confirmed": true}), http.StatusNotFound, "Läsaren hittades inte.")
	want(t, other.pass(id, secret.UUID()), http.StatusNotFound, "Läsaren hittades inte.")

	want(t, b.call("DELETE", "/api/readers/"+id, map[string]bool{"confirmed": false}), http.StatusBadRequest, "Borttagningen måste bekräftas.")
	want(t, b.call("DELETE", "/api/readers/"+id, map[string]bool{"confirmed": true}), http.StatusOK, "")
	if readers := b.call("GET", "/api/readers", nil).body["readers"].([]any); len(readers) != 0 {
		t.Fatalf("readers after delete = %v", readers)
	}
}

func TestPassage(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	id := b.createDoor("Gym", "10", "7")
	first, second := secret.UUID(), secret.UUID()

	res := b.pass(id, first)
	want(t, res, http.StatusOK, "")
	if res.body["ok"] != true || res.body["message"] != "Passageförsöket skickades." || res.body["auditId"] == "" {
		t.Fatalf("passage = %s", res.raw)
	}
	want(t, b.pass(id, first), http.StatusConflict, "Begäran har redan behandlats.")
	want(t, b.pass(id, second), http.StatusTooManyRequests, "Vänta 1 sekund innan nästa försök.")
	a.advance(2 * time.Second)
	// A request refused by the cooldown was not consumed.
	want(t, b.call("POST", "/api/readers/"+id+"/door", map[string]any{"confirmed": true, "requestId": second}), http.StatusOK, "")
	if _, lookups, opened := a.brp.counts(); lookups != 1 || !reflect.DeepEqual(opened, []int{1007, 1007}) {
		t.Fatalf("lookups = %d (want 1: the reader code is cached), opened = %v", lookups, opened)
	}

	path := "/api/readers/" + id + "/passage"
	for name, tc := range map[string]struct {
		body any
		msg  string
	}{
		"not json":      {`{`, "Ogiltig JSON."},
		"not an object": {`7`, "Ogiltig begäran."},
		"customer id":   {map[string]any{"confirmed": true, "requestId": secret.UUID(), "customerId": "1"}, "Kund-ID får inte skickas från klienten."},
		"card reader":   {map[string]any{"confirmed": true, "requestId": secret.UUID(), "cardReader": 1}, "Kortläsare styrs av servern."},
		"unconfirmed":   {map[string]any{"requestId": secret.UUID()}, "Passagen måste bekräftas."},
		"request id":    {map[string]any{"confirmed": true, "requestId": "nope"}, "Ogiltigt request-ID."},
	} {
		res := b.call("POST", path, tc.body)
		if res.status != http.StatusBadRequest || res.body["error"] != tc.msg {
			t.Errorf("%s: %d %s", name, res.status, res.raw)
		}
	}

	a.advance(2 * time.Second)
	a.brp.set(func(f *fakeBRP) { f.passageStatus = http.StatusForbidden })
	want(t, b.pass(id, secret.UUID()), http.StatusBadGateway, "Passageförsöket avvisades.")
	a.advance(2 * time.Second)
	a.brp.set(func(f *fakeBRP) { f.passageStatus = http.StatusUnauthorized })
	want(t, b.pass(id, secret.UUID()), http.StatusUnauthorized, "Passageförsöket avvisades.")
	a.advance(2 * time.Second)
	a.brp.set(func(f *fakeBRP) { f.passageStatus = 0 })
	want(t, b.pass(id, secret.UUID()), http.StatusOK, "")
	if _, lookups, _ := a.brp.counts(); lookups != 3 {
		t.Fatalf("lookups = %d, want 3: a rejection drops the cached code", lookups)
	}

	events := b.call("GET", "/api/readers/"+id, nil).body["events"].([]any)
	if len(events) != 5 {
		t.Fatalf("events = %d, want 5", len(events))
	}
	latest := events[0].(map[string]any)
	if latest["type"] != "passage" || latest["data"].(map[string]any)["outcome"] != "accepted" {
		t.Fatalf("latest event = %v", latest)
	}

	ghost := b.createDoor("Ghost", "10", "404")
	want(t, b.pass(ghost, secret.UUID()), http.StatusNotFound, "Läsaren hittades inte hos BRP.")
}

func TestPassageCanBeSwitchedOff(t *testing.T) {
	a := newApp(t, Config{})
	b := a.signIn(anna, annaPass)
	id := b.createDoor("Gym", "10", "7")
	want(t, b.pass(id, secret.UUID()), http.StatusServiceUnavailable, "Passagefunktionen är inte aktiverad.")
	want(t, b.call("POST", "/api/sequences/"+secret.UUID()+"/run", map[string]any{"confirmed": true, "requestId": secret.UUID()}), http.StatusServiceUnavailable, "Passagefunktionen är inte aktiverad.")
	want(t, a.open("brpd_"+secret.UUID()+"."+secret.Token(32), map[string]string{"doorName": "Gym"}), http.StatusServiceUnavailable, "Door opening is disabled.")
	if _, _, opened := a.brp.counts(); len(opened) != 0 {
		t.Fatalf("doors were opened: %v", opened)
	}
}

func TestDefaultReaderIsSeededOncePerOwner(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true, DefaultReader: 55})
	b := a.signIn(anna, annaPass)
	readers := b.call("GET", "/api/readers", nil).body["readers"].([]any)
	if len(readers) != 1 || readers[0].(map[string]any)["name"] != "Main entrance" {
		t.Fatalf("readers = %v", readers)
	}
	id := readers[0].(map[string]any)["id"].(string)
	want(t, b.pass(id, secret.UUID()), http.StatusOK, "")
	if _, lookups, opened := a.brp.counts(); lookups != 0 || !reflect.DeepEqual(opened, []int{55}) {
		t.Fatalf("lookups = %d, opened = %v", lookups, opened)
	}
	want(t, b.call("DELETE", "/api/readers/"+id, map[string]bool{"confirmed": true}), http.StatusOK, "")
	if readers := b.call("GET", "/api/readers", nil).body["readers"].([]any); len(readers) != 0 {
		t.Fatalf("the default door came back: %v", readers)
	}
}

func TestSequences(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	outer := b.createDoor("Outer", "10", "1")
	inner := b.createDoor("Inner", "10", "2")
	step := func(door string, delay int) map[string]any {
		return map[string]any{"doorName": door, "delaySeconds": delay}
	}

	for name, tc := range map[string]struct {
		body   any
		status int
		msg    string
	}{
		"not json":         {`{`, 400, "Ogiltig JSON."},
		"reader ids":       {map[string]any{"name": "In", "steps": []any{}, "readerIds": []string{outer}}, 400, "Ogiltig begäran."},
		"no steps":         {map[string]any{"name": "In", "steps": []any{}}, 400, "En sekvens måste ha 1–8 steg."},
		"step by id":       {map[string]any{"name": "In", "steps": []any{map[string]any{"readerId": outer}}}, 400, "Dörren måste anges med sparat namn."},
		"long delay":       {map[string]any{"name": "In", "steps": []any{step("Outer", 11), step("Inner", 0)}}, 400, "Väntetiden måste vara 0–10 sekunder."},
		"fractional delay": {map[string]any{"name": "In", "steps": []any{map[string]any{"doorName": "Outer", "delaySeconds": 1.5}, step("Inner", 0)}}, 400, "Väntetiden måste vara 0–10 sekunder."},
		"total delay":      {map[string]any{"name": "In", "steps": []any{step("Outer", 10), step("Inner", 10), step("Outer", 10), step("Inner", 5), step("Outer", 0)}}, 400, "Total väntetid får vara högst 30 sekunder."},
		"unknown door":     {map[string]any{"name": "In", "steps": []any{step("Cellar", 0)}}, 404, "En sparad dörr hittades inte."},
	} {
		res := b.call("POST", "/api/sequences", tc.body)
		if res.status != tc.status || res.body["error"] != tc.msg {
			t.Errorf("%s: %d %s", name, res.status, res.raw)
		}
	}

	created := b.call("POST", "/api/sequences", map[string]any{"name": "Way in", "steps": []any{step("outer", 3), step("Inner", 9)}})
	want(t, created, http.StatusCreated, "")
	sequence := created.body["sequence"].(map[string]any)
	id := sequence["id"].(string)
	steps := sequence["steps"].([]any)
	if steps[0].(map[string]any)["doorName"] != "Outer" || steps[0].(map[string]any)["delaySeconds"] != 3.0 || steps[1].(map[string]any)["delaySeconds"] != 0.0 {
		t.Fatalf("steps = %v", steps)
	}
	want(t, b.call("POST", "/api/sequences", map[string]any{"name": "WAY IN", "steps": []any{step("Outer", 0)}}), http.StatusConflict, "En sekvens med samma namn finns redan.")
	want(t, b.call("PATCH", "/api/sequences/"+secret.UUID(), map[string]any{"name": "Other", "steps": []any{step("Outer", 0)}}), http.StatusNotFound, "Sekvensen hittades inte.")

	run := func(requestID string) reply {
		return b.call("POST", "/api/sequences/"+id+"/run", map[string]any{"confirmed": true, "requestId": requestID})
	}
	requestID := secret.UUID()
	res := run(requestID)
	want(t, res, http.StatusOK, "")
	if res.body["completedSteps"] != 2.0 || res.body["message"] != "Sekvensen slutfördes." {
		t.Fatalf("run = %s", res.raw)
	}
	if _, _, opened := a.brp.counts(); !reflect.DeepEqual(opened, []int{1001, 1002}) || !reflect.DeepEqual(a.slept, []time.Duration{3 * time.Second}) {
		t.Fatalf("opened = %v, slept = %v", opened, a.slept)
	}
	want(t, run(requestID), http.StatusConflict, "Begäran har redan behandlats.")
	want(t, b.call("POST", "/api/sequences/"+id+"/run", map[string]any{"requestId": secret.UUID()}), http.StatusBadRequest, "Ogiltig begäran.")
	want(t, b.call("POST", "/api/sequences/"+secret.UUID()+"/run", map[string]any{"confirmed": true, "requestId": secret.UUID()}), http.StatusNotFound, "Sekvensen hittades inte eller saknar giltiga steg.")

	a.advance(2 * time.Second)
	a.brp.set(func(f *fakeBRP) { f.rejectReader = 1002 })
	res = run(secret.UUID())
	want(t, res, http.StatusBadGateway, "Dörrförsöket avvisades.")
	if res.body["failedStep"] != 2.0 || res.body["completedSteps"] != 1.0 {
		t.Fatalf("failed run = %s", res.raw)
	}
	a.brp.set(func(f *fakeBRP) { f.rejectReader = 0 })

	// Another account cannot run or change it.
	other := a.signIn(bo, boPass)
	want(t, other.call("POST", "/api/sequences/"+id+"/run", map[string]any{"confirmed": true, "requestId": secret.UUID()}), http.StatusNotFound, "")
	want(t, other.call("DELETE", "/api/sequences/"+id, map[string]bool{"confirmed": true}), http.StatusNotFound, "Sekvensen hittades inte.")

	patched := b.call("PATCH", "/api/sequences/"+id, map[string]any{"name": "Way in", "steps": []any{step("Inner", 0)}})
	want(t, patched, http.StatusOK, "")
	if got := patched.body["sequence"].(map[string]any)["steps"].([]any); len(got) != 1 {
		t.Fatalf("patched steps = %v", got)
	}

	want(t, b.call("PUT", "/api/default", map[string]string{"type": "lift", "name": "Way in"}), http.StatusBadRequest, "Ogiltig standardtyp.")
	want(t, b.call("PUT", "/api/default", map[string]string{"type": "sequence", "name": "Nope"}), http.StatusNotFound, "Valet hittades inte.")
	want(t, b.call("PUT", "/api/default", map[string]string{"type": "sequence", "name": "way in"}), http.StatusOK, "")
	selection := b.call("GET", "/api/default", nil).body["defaultSelection"].(map[string]any)
	if selection["type"] != "sequence" || selection["id"] != id {
		t.Fatalf("default = %v", selection)
	}

	// Deleting its only door removes the sequence and the default with it.
	want(t, b.call("DELETE", "/api/readers/"+inner, map[string]bool{"confirmed": true}), http.StatusOK, "")
	if sequences := b.call("GET", "/api/sequences", nil).body["sequences"].([]any); len(sequences) != 0 {
		t.Fatalf("sequences = %v", sequences)
	}
	selection = b.call("GET", "/api/default", nil).body["defaultSelection"].(map[string]any)
	if selection["type"] != "door" || selection["id"] != outer {
		t.Fatalf("default after delete = %v", selection)
	}
	want(t, b.call("DELETE", "/api/sequences/"+id, map[string]bool{"confirmed": true}), http.StatusNotFound, "Sekvensen hittades inte.")
	want(t, b.call("DELETE", "/api/sequences/"+id, `{}`), http.StatusBadRequest, "Borttagningen måste bekräftas.")
}

func TestDeviceCredential(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	gym := b.createDoor("Gym", "10", "1")
	b.createDoor("Sauna", "10", "2")
	foreign := a.signIn(bo, boPass).createDoor("Gym", "10", "9")
	door := func(id string) []any { return []any{map[string]string{"type": "door", "id": id}} }

	for name, tc := range map[string]struct {
		body any
		msg  string
	}{
		"not json":        {`{`, "Invalid request."},
		"no name":         {map[string]any{"name": ""}, "Invalid device name."},
		"zero days":       {map[string]any{"name": "Phone", "expiresInDays": 0}, "Expiry must be never or 1-90 days."},
		"too many days":   {map[string]any{"name": "Phone", "expiresInDays": 91}, "Expiry must be never or 1-90 days."},
		"bad target type": {map[string]any{"name": "Phone", "targets": []any{map[string]string{"type": "lift", "id": gym}}}, "Invalid target allowlist."},
		"foreign target":  {map[string]any{"name": "Phone", "targets": door(foreign)}, "Invalid target allowlist."},
	} {
		res := b.call("POST", "/api/device-sessions", tc.body)
		if res.status != http.StatusBadRequest || res.body["error"] != tc.msg {
			t.Errorf("%s: %d %s", name, res.status, res.raw)
		}
	}

	created := b.call("POST", "/api/device-sessions", map[string]any{"name": "iPhone", "expiresInDays": 30, "targets": door(gym)})
	want(t, created, http.StatusCreated, "")
	credential := created.body["credential"].(string)
	deviceID := created.body["device"].(map[string]any)["id"].(string)
	if _, _, ok := parseCredential(credential); !ok {
		t.Fatalf("credential has the wrong shape")
	}
	want(t, b.call("POST", "/api/device-sessions", map[string]any{"name": "iphone"}), http.StatusConflict, "A device with that name already exists.")

	res := a.open(credential, map[string]string{"doorName": "gym"})
	want(t, res, http.StatusOK, "")
	if res.body["ok"] != true || res.body["completedSteps"] != 1.0 || res.body["message"] != "Request completed." {
		t.Fatalf("open = %s", res.raw)
	}
	if _, _, opened := a.brp.counts(); !reflect.DeepEqual(opened, []int{1001}) {
		t.Fatalf("opened = %v", opened)
	}
	want(t, a.open(credential, map[string]string{"doorName": "Gym"}), http.StatusTooManyRequests, "Wait 1 second before retrying.")

	for name, tc := range map[string]struct {
		body   any
		status int
		msg    string
	}{
		"outside allowlist": {map[string]string{"doorName": "Sauna"}, 403, "Target is not allowed for this device."},
		"unknown target":    {map[string]string{"doorName": "Cellar"}, 404, "Target not found."},
		"extra field":       {map[string]any{"doorName": "Gym", "cardReader": 1}, 400, "Invalid request."},
		"no target":         {map[string]any{}, 400, "Provide exactly one doorName or sequenceName."},
		"two targets":       {map[string]string{"doorName": "Gym", "sequenceName": "In"}, 400, "Provide exactly one doorName or sequenceName."},
		"bad name":          {map[string]string{"doorName": "<x>"}, 400, "Invalid target name."},
		"not json":          {`{`, 400, "Invalid request."},
		"too large":         {map[string]string{"doorName": strings.Repeat("a", 3000)}, 413, "Invalid request."},
	} {
		a.advance(2 * time.Second)
		res := a.open(credential, tc.body)
		if res.status != tc.status || res.body["error"] != tc.msg {
			t.Errorf("%s: %d %s", name, res.status, res.raw)
		}
	}
	a.advance(2 * time.Second)
	want(t, a.open(credential, map[string]string{"doorName": "Gym"}, header("Origin", evilOrigin)), http.StatusForbidden, "Forbidden.")
	want(t, a.open(credential[:len(credential)-1]+"_", map[string]string{"doorName": "Gym"}), http.StatusUnauthorized, "Invalid or expired device credential.")
	want(t, a.open("brpd_"+secret.UUID()+"."+secret.Token(32), map[string]string{"doorName": "Gym"}), http.StatusUnauthorized, "Invalid or expired device credential.")

	listed := b.call("GET", "/api/device-sessions", nil)
	device := listed.body["devices"].([]any)[0].(map[string]any)
	if device["lastUsedAt"] == nil || device["sessionStatus"] != "healthy" || device["expiresAt"] != "2026-11-03T12:00:00.000Z" ||
		!reflect.DeepEqual(device["targets"], []any{map[string]any{"type": "door", "name": "Gym"}}) {
		t.Fatalf("device = %v", device)
	}
	if strings.Contains(listed.raw, credential) || strings.Contains(listed.raw, "tokenHash") {
		t.Fatalf("the list leaks the credential: %s", listed.raw)
	}

	// Deleting the only allowed door must not widen the credential.
	want(t, b.call("DELETE", "/api/readers/"+gym, map[string]bool{"confirmed": true}), http.StatusOK, "")
	want(t, a.open(credential, map[string]string{"doorName": "Sauna"}), http.StatusForbidden, "Target is not allowed for this device.")

	path := "/api/device-sessions/" + deviceID
	want(t, b.call("PATCH", path, map[string]string{"name": "Phone"}), http.StatusOK, "")
	want(t, b.call("PATCH", path, map[string]string{"name": "<x>"}), http.StatusBadRequest, "Invalid device name.")
	rotated := b.call("POST", path+"/rotate", `{}`)
	want(t, rotated, http.StatusOK, "")
	fresh := rotated.body["credential"].(string)
	want(t, a.open(credential, map[string]string{"doorName": "Sauna"}), http.StatusUnauthorized, "Invalid or expired device credential.")
	want(t, b.call("DELETE", path, `{}`), http.StatusOK, "")
	want(t, a.open(fresh, map[string]string{"doorName": "Sauna"}), http.StatusUnauthorized, "Invalid or expired device credential.")

	other := a.signIn(bo, boPass)
	for _, call := range []reply{
		other.call("DELETE", path, `{}`),
		other.call("PATCH", path, map[string]string{"name": "Mine"}),
		other.call("POST", path+"/rotate", `{}`),
		other.call("POST", path+"/reauthorize", `{}`),
	} {
		want(t, call, http.StatusNotFound, "Device not found.")
	}
}

func TestDeviceCredentialRunsSequencesAndExpires(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	b.createDoor("Outer", "10", "1")
	b.createDoor("Inner", "10", "2")
	want(t, b.call("POST", "/api/sequences", map[string]any{"name": "Way in", "steps": []any{
		map[string]any{"doorName": "Outer", "delaySeconds": 2}, map[string]any{"doorName": "Inner", "delaySeconds": 0},
	}}), http.StatusCreated, "")

	never := b.call("POST", "/api/device-sessions", map[string]any{"name": "Watch", "expiresInDays": "never"})
	want(t, never, http.StatusCreated, "")
	if never.body["device"].(map[string]any)["expiresAt"] != nil {
		t.Fatalf("never-expiring device = %s", never.raw)
	}
	watch := never.body["credential"].(string)
	watchID := never.body["device"].(map[string]any)["id"].(string)
	short := b.call("POST", "/api/device-sessions", map[string]any{"name": "Tablet", "expiresInDays": "1"})
	want(t, short, http.StatusCreated, "")
	tablet := short.body["credential"].(string)

	res := a.open(watch, map[string]string{"sequenceName": "way in"})
	want(t, res, http.StatusOK, "")
	if _, _, opened := a.brp.counts(); res.body["completedSteps"] != 2.0 || !reflect.DeepEqual(opened, []int{1001, 1002}) {
		t.Fatalf("open = %s, opened = %v", res.raw, opened)
	}
	a.advance(2 * time.Second)
	a.brp.set(func(f *fakeBRP) { f.rejectReader = 1002 })
	res = a.open(watch, map[string]string{"sequenceName": "Way in"})
	want(t, res, http.StatusBadGateway, "Dörrförsöket avvisades.")
	if res.body["failedStep"] != 2.0 || res.body["completedSteps"] != 1.0 {
		t.Fatalf("failed open = %s", res.raw)
	}
	a.brp.set(func(f *fakeBRP) { f.rejectReader = 0 })

	a.advance(25 * time.Hour)
	want(t, a.open(tablet, map[string]string{"doorName": "Outer"}), http.StatusUnauthorized, "Invalid or expired device credential.")

	// Once the upstream session is gone the credential needs the owner again.
	a.advance(week)
	want(t, a.open(watch, map[string]string{"doorName": "Outer"}), http.StatusUnauthorized, "Device session needs reauthorization.")
	b = a.signIn(anna, annaPass)
	status := b.call("GET", "/api/device-sessions", nil).body["ownerSession"].(map[string]any)["sessionStatus"]
	if status != "healthy" {
		t.Fatalf("status after login = %v", status)
	}
	want(t, b.call("POST", "/api/device-sessions/"+watchID+"/reauthorize", `{}`), http.StatusOK, "")
	a.advance(2 * time.Second)
	want(t, a.open(watch, map[string]string{"doorName": "Outer"}), http.StatusOK, "")
}

func TestStepsWithoutADelayOpenTogether(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	doors := []string{b.createDoor("Outer", "10", "1"), b.createDoor("Inner", "10", "2"), b.createDoor("Locker", "10", "3")}
	want(t, b.call("POST", "/api/sequences", map[string]any{"name": "Way in", "steps": []any{
		map[string]any{"doorName": "Outer", "delaySeconds": 0}, map[string]any{"doorName": "Inner", "delaySeconds": 4}, map[string]any{"doorName": "Locker", "delaySeconds": 0},
	}}), http.StatusCreated, "")
	created := b.call("POST", "/api/device-sessions", map[string]any{"name": "Watch", "expiresInDays": "never"})
	want(t, created, http.StatusCreated, "")
	watch := created.body["credential"].(string)

	// BRP answers neither of the first two doors until it has both requests.
	arrived, release := make(chan struct{}, 3), make(chan struct{})
	a.brp.set(func(f *fakeBRP) {
		f.passageWait = func() {
			arrived <- struct{}{}
			<-release
		}
	})
	together := make(chan bool, 1)
	go func() {
		ok := true
		for range 2 {
			select {
			case <-arrived:
			case <-time.After(5 * time.Second):
				ok = false
			}
		}
		together <- ok
		close(release)
	}()
	res := a.open(watch, map[string]string{"sequenceName": "Way in"})
	if !<-together {
		t.Fatal("the two steps without a delay between them were not sent together")
	}
	want(t, res, http.StatusOK, "")
	_, _, opened := a.brp.counts()
	if res.body["completedSteps"] != 3.0 || len(opened) != 3 || opened[2] != 1003 || !reflect.DeepEqual(a.slept, []time.Duration{4 * time.Second}) {
		t.Fatalf("open = %s, opened = %v, slept = %v", res.raw, opened, a.slept)
	}

	// The first failure is reported, later steps do not run, and every door
	// that was tried has its attempt in the audit log.
	a.advance(2 * time.Second)
	a.brp.set(func(f *fakeBRP) { f.rejectReader = 1001 })
	res = a.open(watch, map[string]string{"sequenceName": "Way in"})
	want(t, res, http.StatusBadGateway, "Dörrförsöket avvisades.")
	if _, _, opened := a.brp.counts(); res.body["failedStep"] != 1.0 || res.body["completedSteps"] != 0.0 || len(opened) != 5 {
		t.Fatalf("failed open = %s, opened = %v", res.raw, opened)
	}
	for i, wantOutcomes := range [][]string{{"rejected", "accepted"}, {"accepted", "accepted"}, {"accepted"}} {
		var got []string
		for _, e := range b.call("GET", "/api/readers/"+doors[i], nil).body["events"].([]any) {
			got = append(got, e.(map[string]any)["data"].(map[string]any)["outcome"].(string))
		}
		if !reflect.DeepEqual(got, wantOutcomes) {
			t.Errorf("door %d audit log = %v, want %v", i+1, got, wantOutcomes)
		}
	}
}

func TestLegacyOpenDoor(t *testing.T) {
	legacy := func(a *app, key string, body any) reply {
		a.t.Helper()
		return a.send("POST", "/api/open-door", body, header("X-Api-Key", key))
	}
	request := map[string]string{"email": anna, "password": annaPass, "doorName": "Gym"}

	off := newApp(t, Config{PassageEnabled: true})
	want(t, legacy(off, "", request), http.StatusUnauthorized, "Unauthorized.")

	a := newApp(t, Config{PassageEnabled: true, LegacyAPIKey: "shared-key"})
	a.signIn(anna, annaPass).createDoor("Gym", "10", "1")
	want(t, legacy(a, "wrong", request), http.StatusUnauthorized, "Unauthorized.")
	want(t, legacy(a, "shared-key", request), http.StatusTooManyRequests, "Try again in 1 second.")
	a.advance(2 * time.Second)
	res := legacy(a, "shared-key", request)
	want(t, res, http.StatusOK, "")
	if _, _, opened := a.brp.counts(); res.body["completedSteps"] != 1.0 || !reflect.DeepEqual(opened, []int{1001}) {
		t.Fatalf("open = %s, opened = %v", res.raw, opened)
	}

	for name, tc := range map[string]struct {
		body   map[string]string
		status int
		msg    string
	}{
		"wrong password": {map[string]string{"email": anna, "password": "wrong", "doorName": "Gym"}, 401, "Invalid credentials."},
		"customer id":    {map[string]string{"email": anna, "password": annaPass, "doorName": "Gym", "customerId": "1"}, 400, "Invalid request."},
		"bad email":      {map[string]string{"email": "anna", "password": annaPass, "doorName": "Gym"}, 400, "Invalid email."},
		"no password":    {map[string]string{"email": anna, "doorName": "Gym"}, 400, "Invalid password."},
		"unknown target": {map[string]string{"email": anna, "password": annaPass, "sequenceName": "Nope"}, 404, "Target not found."},
	} {
		a.advance(2 * time.Second)
		res := legacy(a, "shared-key", tc.body)
		if res.status != tc.status || res.body["error"] != tc.msg {
			t.Errorf("%s: %d %s", name, res.status, res.raw)
		}
	}
}

func TestScheduledReauthorization(t *testing.T) {
	ctx := context.Background()
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	b.createDoor("Gym", "10", "1")
	created := b.call("POST", "/api/device-sessions", map[string]any{"name": "Watch", "expiresInDays": "never"})
	credential := created.body["credential"].(string)
	ownerSession := func() map[string]any {
		t.Helper()
		return b.call("GET", "/api/device-sessions", nil).body["ownerSession"].(map[string]any)
	}

	want(t, b.call("POST", "/api/scheduled-reauth", `{`), http.StatusBadRequest, "Invalid request.")
	want(t, b.call("POST", "/api/scheduled-reauth", map[string]string{"username": anna}), http.StatusBadRequest, "Email and password are required.")
	want(t, b.call("POST", "/api/scheduled-reauth", map[string]string{"username": anna, "password": "wrong"}), http.StatusUnauthorized, "Invalid email or password.")
	want(t, b.call("POST", "/api/scheduled-reauth", map[string]string{"username": bo, "password": boPass}), http.StatusForbidden, "The account does not match the signed-in owner.")

	enabled := b.call("POST", "/api/scheduled-reauth", map[string]string{"username": anna, "password": annaPass})
	want(t, enabled, http.StatusOK, "")
	if enabled.body["scheduledReauthEnabled"] != true || enabled.body["nextReauthAt"] != "2026-10-07T12:00:00.000Z" {
		t.Fatalf("enabled = %s", enabled.raw)
	}
	if got := ownerSession(); got["scheduledReauthEnabled"] != true || got["sessionStatus"] != "healthy" {
		t.Fatalf("owner session = %v", got)
	}

	before, _, _ := a.brp.counts()
	a.srv.maintain(ctx)
	if after, _, _ := a.brp.counts(); after != before {
		t.Fatalf("renewed before it was due")
	}
	a.advance(reauthEvery + time.Minute)
	a.srv.maintain(ctx)
	if after, _, _ := a.brp.counts(); after != before+1 {
		t.Fatalf("logins = %d, want %d", after, before+1)
	}
	if got := ownerSession(); got["upstreamExpiresAt"] != "2026-10-14T12:01:00.000Z" || got["lastReauthAt"] != "2026-10-07T12:01:00.000Z" {
		t.Fatalf("renewed owner session = %v", got)
	}

	// BRP being down is retried; the current session keeps working.
	a.advance(reauthEvery + time.Minute)
	a.brp.set(func(f *fakeBRP) { f.loginStatus = http.StatusInternalServerError })
	a.srv.maintain(ctx)
	if got := ownerSession(); got["sessionStatus"] != "refresh_failed" || got["scheduledReauthEnabled"] != true {
		t.Fatalf("after a transient failure = %v", got)
	}
	want(t, a.open(credential, map[string]string{"doorName": "Gym"}), http.StatusOK, "")

	// A rejected login turns renewal off and deletes the stored login.
	a.advance(reauthRetry + time.Minute)
	a.brp.set(func(f *fakeBRP) { f.loginStatus = 0; f.passwords[anna] = "changed" })
	a.srv.maintain(ctx)
	if got := ownerSession(); got["sessionStatus"] != "reauthorization_required" || got["scheduledReauthEnabled"] != false || got["nextReauthAt"] != nil {
		t.Fatalf("after a rejected login = %v", got)
	}
	o, err := a.srv.st.OwnerSession(ctx, b.owner())
	if err != nil || o.ReauthCiphertext != nil {
		t.Fatalf("stored login kept after rejection: %v %v", o.ReauthCiphertext, err)
	}
	want(t, a.open(credential, map[string]string{"doorName": "Gym"}), http.StatusUnauthorized, "Device session needs reauthorization.")

	a.brp.set(func(f *fakeBRP) { f.passwords[anna] = annaPass })
	want(t, b.call("POST", "/api/scheduled-reauth", map[string]string{"username": anna, "password": annaPass}), http.StatusOK, "")
	disabled := b.call("DELETE", "/api/scheduled-reauth", nil)
	want(t, disabled, http.StatusOK, "")
	if disabled.body["scheduledReauthEnabled"] != false || ownerSession()["scheduledReauthEnabled"] != false {
		t.Fatalf("disabled = %s", disabled.raw)
	}
}

// owner is the browser's owner id, for looking at stored rows.
func (b *browser) owner() string {
	row, err := b.app.srv.st.BrowserSession(context.Background(), secret.SessionKey(b.cookie), 0)
	if err != nil {
		b.app.t.Fatal(err)
	}
	return row.Owner
}

func TestStaticFilesAndSecurityHeaders(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	shell := a.send("GET", "/", nil)
	want(t, shell, http.StatusOK, "")
	if !strings.Contains(shell.raw, `<div id="app"`) {
		t.Fatalf("shell = %s", shell.raw)
	}
	for key, value := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
		"Cache-Control":          "no-cache",
	} {
		if got := shell.header.Get(key); got != value {
			t.Errorf("%s = %q, want %q", key, got, value)
		}
	}
	if csp := shell.header.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") || strings.Contains(csp, "unsafe") {
		t.Errorf("CSP = %q", csp)
	}
	if route := a.send("GET", "/readers/anything", nil); route.raw != shell.raw {
		t.Errorf("client-side route did not get the shell")
	}
	// What an iPhone needs to run the page as a home-screen app.
	for _, tag := range []string{
		`name="apple-mobile-web-app-capable" content="yes"`,
		`name="mobile-web-app-capable" content="yes"`,
		`name="apple-mobile-web-app-title" content="STC"`,
		`rel="apple-touch-icon"`,
		`rel="manifest" href="/site.webmanifest"`,
		`viewport-fit=cover`,
		`<script src="/theme.js"></script>`,
	} {
		if !strings.Contains(shell.raw, tag) {
			t.Errorf("shell lacks %s", tag)
		}
	}
	// The CSP allows no inline code, so the shell must not carry any.
	if strings.Contains(shell.raw, "<script>") || strings.Contains(shell.raw, "<style") || strings.Contains(shell.raw, "style=") {
		t.Errorf("shell has inline script or style")
	}
	manifest := a.send("GET", "/site.webmanifest", nil)
	if manifest.header.Get("Content-Type") != "application/manifest+json" {
		t.Errorf("manifest type = %q", manifest.header.Get("Content-Type"))
	}
	for _, field := range []string{`"display": "standalone"`, `"short_name": "STC"`, `"start_url": "/"`} {
		if !strings.Contains(manifest.raw, field) {
			t.Errorf("manifest lacks %s", field)
		}
	}
	for _, file := range []string{"/app.js", "/theme.js", "/launch.js", "/style.css", "/sw.js", "/icon.svg", "/icon-192.png", "/apple-touch-icon.png"} {
		if res := a.send("GET", file, nil); res.status != http.StatusOK || res.raw == shell.raw {
			t.Errorf("%s: %d", file, res.status)
		}
	}
	if !strings.Contains(shell.raw, `<script src="/launch.js"></script>`) {
		t.Errorf("shell lacks the launch backdrop script")
	}
	// A transform on #app would become the containing block of the fixed
	// header and bottom nav, which then float mid-screen during launch.
	css := a.send("GET", "/style.css", nil).raw
	for _, rule := range strings.Split(css, "}") {
		selector, body, _ := strings.Cut(rule, "{")
		if strings.HasSuffix(strings.TrimSpace(selector), "#app") && strings.Contains(body, "transform:") {
			t.Errorf("#app must not be transformed: %s", strings.TrimSpace(rule))
		}
	}
	want(t, a.send("POST", "/", nil), http.StatusMethodNotAllowed, "method not allowed")
	if health := a.send("GET", "/healthz", nil); health.status != http.StatusOK || health.body["ok"] != true {
		t.Errorf("healthz = %d %s", health.status, health.raw)
	}
	if api := a.send("GET", "/api/session", nil); api.header.Get("Cache-Control") != "no-store" {
		t.Errorf("API responses must not be cached")
	}
}

func TestSessionAndRenewalTiming(t *testing.T) {
	const now = int64(1_000_000_000_000)
	day := (24 * time.Hour).Milliseconds()
	for name, tc := range map[string]struct{ expiresAt, want int64 }{
		"long session renews after three days": {now + 7*day, now + 3*day},
		"short session renews before expiry":   {now + 2*day, now + 2*day - reauthMargin.Milliseconds()},
		"nearly expired renews now":            {now + day, now},
	} {
		if got := nextReauthAt(now, tc.expiresAt); got != tc.want {
			t.Errorf("%s: %d, want %d", name, got, tc.want)
		}
	}
	for name, tc := range map[string]struct {
		expiresAt int64
		want      int
	}{
		"a week":            {now + 7*day, maxSessionSeconds},
		"capped at a week":  {now + 30*day, maxSessionSeconds},
		"rounded up":        {now + 90_500, 91},
		"at least a minute": {now + 1, minSessionSeconds},
	} {
		if got := sessionTTL(now, tc.expiresAt); got != tc.want {
			t.Errorf("%s: %d, want %d", name, got, tc.want)
		}
	}
}

func TestClientIPTrustsOnlyTheProxyEntry(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "172.18.0.1:5555"
	if got := clientIP(r); got != "172.18.0.1" {
		t.Errorf("without a proxy header: %q", got)
	}
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 100.64.0.7")
	if got := clientIP(r); got != "100.64.0.7" {
		t.Errorf("a client-supplied entry was trusted: %q", got)
	}
}

func TestGateAndThrottleForgetExpiredEntries(t *testing.T) {
	now := time.Unix(0, 0)
	g := newGate()
	for i := range sweepSize {
		g.acquire(strconv.Itoa(i), time.Second, now)
	}
	if !g.held("0", now) || g.acquire("0", time.Second, now) {
		t.Fatal("a held slot was handed out twice")
	}
	later := now.Add(2 * time.Second)
	if !g.acquire("fresh", time.Second, later) || len(g.until) != 1 {
		t.Fatalf("expired slots were kept: %d", len(g.until))
	}

	th := newThrottle(time.Minute)
	first, second, third := th.take("0", 2, now), th.take("0", 2, now), th.take("0", 2, now)
	if !first || !second || third {
		t.Fatal("attempts were miscounted")
	}
	th.release("0")
	if !th.take("0", 2, now) {
		t.Fatal("a released attempt still counts")
	}
	for i := 1; i < sweepSize; i++ {
		th.take(strconv.Itoa(i), 2, now)
	}
	later = now.Add(2 * time.Minute)
	if !th.take("fresh", 1, later) || len(th.entries) != 1 {
		t.Fatalf("expired attempts were kept: %d", len(th.entries))
	}
	th.clear("fresh")
	if !th.take("fresh", 1, later) {
		t.Fatal("a cleared key is still blocked")
	}
}

func TestParallelGuessesStayInsideTheLimit(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	anon := &browser{app: a}
	const guesses = 40
	statuses := make(chan int, guesses)
	for range guesses {
		go func() {
			statuses <- anon.call("POST", "/api/login", map[string]string{"username": anna, "password": "wrong"}).status
		}()
	}
	rejected := 0
	for range guesses {
		if <-statuses == http.StatusUnauthorized {
			rejected++
		}
	}
	if logins, _, _ := a.brp.counts(); rejected != loginUserLimit || logins != loginUserLimit {
		t.Fatalf("%d guesses reached BRP and %d were answered 401, want %d of each", logins, rejected, loginUserLimit)
	}
}

func TestOnlyRefusedLoginsCountAsGuesses(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	anon := &browser{app: a}
	login := map[string]string{"username": anna, "password": annaPass}

	// BRP being down is nobody's wrong password.
	a.brp.set(func(f *fakeBRP) { f.loginStatus = http.StatusServiceUnavailable })
	for range loginUserLimit + 1 {
		want(t, anon.call("POST", "/api/login", login), http.StatusBadGateway, "Inloggningen misslyckades.")
	}
	// Neither is a correct one, however often it is used.
	a.brp.set(func(f *fakeBRP) { f.loginStatus = 0 })
	for range loginClientLimit + 1 {
		want(t, anon.call("POST", "/api/login", login), http.StatusOK, "")
	}
	// A refusal that is not a 401 still is.
	a.brp.set(func(f *fakeBRP) { f.loginStatus = http.StatusForbidden })
	for range loginUserLimit {
		want(t, anon.call("POST", "/api/login", login), http.StatusBadGateway, "Inloggningen misslyckades.")
	}
	want(t, anon.call("POST", "/api/login", login), http.StatusTooManyRequests, "För många inloggningsförsök. Försök igen senare.")
}

func TestReauthorizeKeepsANewerRenewedSession(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	created := b.call("POST", "/api/device-sessions", map[string]any{"name": "Watch", "expiresInDays": "never"})
	path := "/api/device-sessions/" + created.body["device"].(map[string]any)["id"].(string) + "/reauthorize"
	expires := func() any {
		t.Helper()
		return b.call("GET", "/api/device-sessions", nil).body["ownerSession"].(map[string]any)["upstreamExpiresAt"]
	}

	// A later sign-in elsewhere gives the owner a session that lasts longer
	// than this browser's.
	a.advance(24 * time.Hour)
	a.signIn(anna, annaPass)
	newer := expires()
	want(t, b.call("POST", path, `{}`), http.StatusOK, "")
	if got := expires(); got != newer {
		t.Fatalf("the older browser session replaced the newer one: %v → %v", newer, got)
	}

	// Once the owner session needs reauthorization, the browser's is used.
	if err := a.srv.st.SaveReauthFailure(context.Background(), secret.UUID(), b.owner(), store.StatusReauthRequired, "credentials_rejected", true, 0, 0, store.Stamp(a.clock())); err != nil {
		t.Fatal(err)
	}
	want(t, b.call("POST", path, `{}`), http.StatusOK, "")
	session := b.call("GET", "/api/device-sessions", nil).body["ownerSession"].(map[string]any)
	if session["sessionStatus"] != "healthy" || session["upstreamExpiresAt"] != "2026-10-11T12:00:00.000Z" {
		t.Fatalf("after reauthorizing = %v", session)
	}
}

func TestOpenDoorTimingReportsEachUpstreamRequest(t *testing.T) {
	a := newApp(t, Config{PassageEnabled: true})
	b := a.signIn(anna, annaPass)
	b.createDoor("Gym", "10", "1")
	credential := b.call("POST", "/api/device-sessions", map[string]any{"name": "iPhone"}).body["credential"].(string)
	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	// upstream is the "upstream" field of the timing line of one request.
	upstream := func() []any {
		t.Helper()
		logged.Reset()
		a.advance(2 * time.Second)
		want(t, a.open(credential, map[string]string{"doorName": "Gym"}), http.StatusOK, "")
		for _, line := range strings.Split(logged.String(), "\n") {
			_, raw, _ := strings.Cut(line, "{")
			var event map[string]any
			if json.Unmarshal([]byte("{"+raw), &event) == nil && event["event"] == "open_door_timing" {
				list, _ := event["upstream"].([]any)
				return list
			}
		}
		t.Fatalf("no timing line in %q", logged.String())
		return nil
	}

	if first := upstream(); len(first) != 2 {
		t.Fatalf("the first request looks the reader up and opens it, got %v", first)
	}
	second := upstream()
	if len(second) != 1 {
		t.Fatalf("a later request is one upstream call, got %v", second)
	}
	entry := second[0].(map[string]any)
	if entry["reused"] != true {
		t.Fatalf("the connection to BRP must be reused: %v", entry)
	}
	for _, key := range []string{"connMs", "waitMs", "idleMs", "tlsResumed"} {
		if _, ok := entry[key]; !ok {
			t.Fatalf("%s is missing from %v", key, entry)
		}
	}
}
