package brp

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type call struct {
	method, path, query, auth, cookie, source, userAgent, body string
}

// fakeBRP records every request and answers from handler.
func fakeBRP(t *testing.T, handler func(w http.ResponseWriter, c call)) (*Client, *[]call) {
	t.Helper()
	var calls []call
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c := call{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("Cookie"), r.Header.Get("X-Request-Source"), r.Header.Get("User-Agent"), string(body)}
		calls = append(calls, c)
		handler(w, c)
	}))
	t.Cleanup(srv.Close)
	client := New(srv.URL+"/", "383")
	client.Now = func() time.Time { return time.UnixMilli(1_000_000) }
	return client, &calls
}

func TestLoginPinsAffinityCookieThenAuthenticates(t *testing.T) {
	client, calls := fakeBRP(t, func(w http.ResponseWriter, c call) {
		if c.path == "/apps/383" {
			w.Header().Set("Set-Cookie", "GCLB=affinity; Path=/; HttpOnly")
			io.WriteString(w, "{}")
			return
		}
		io.WriteString(w, `{"access_token":"mock-access","refresh_token":"mock-refresh","username":"customer-1","expires_in":3600}`)
	})

	got, err := client.Login(context.Background(), "person@example.test", "mock-password")

	if err != nil {
		t.Fatal(err)
	}
	want := Session{CustomerID: "customer-1", AccessToken: "mock-access", RefreshToken: "mock-refresh", Cookie: "GCLB=affinity", ExpiresAt: 1_000_000 + 3_600_000}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if len(*calls) != 2 {
		t.Fatalf("want 2 calls, got %d", len(*calls))
	}
	first, second := (*calls)[0], (*calls)[1]
	if first.method != "GET" || first.query != "allowMultipleCompaniesAndBusinessUnits=true" {
		t.Fatalf("unexpected config call %+v", first)
	}
	if second.method != "POST" || second.path != "/auth/login" || second.cookie != "GCLB=affinity" || second.source != "mobilityapp" || second.userAgent != "" {
		t.Fatalf("unexpected login call %+v", second)
	}
	var sent map[string]string
	if err := json.Unmarshal([]byte(second.body), &sent); err != nil || sent["username"] != "person@example.test" || sent["password"] != "mock-password" {
		t.Fatalf("unexpected login body %q", second.body)
	}
}

func TestLoginPrefersTheLoginCookieAndDefaultsExpiry(t *testing.T) {
	client, _ := fakeBRP(t, func(w http.ResponseWriter, c call) {
		if c.path == "/auth/login" {
			w.Header().Set("Set-Cookie", "GCLB=login; Secure")
			io.WriteString(w, `{"access_token":"a","username":"customer-1"}`)
			return
		}
		w.Header().Set("Set-Cookie", "GCLB=affinity")
		io.WriteString(w, "{}")
	})

	got, err := client.Login(context.Background(), "u", "p")

	if err != nil {
		t.Fatal(err)
	}
	if got.Cookie != "GCLB=login" {
		t.Fatalf("cookie = %q", got.Cookie)
	}
	if want := int64(1_000_000 + defaultSessionSeconds*1000); got.ExpiresAt != want {
		t.Fatalf("expiry = %d, want %d", got.ExpiresAt, want)
	}
}

func TestLoginMapsFailures(t *testing.T) {
	tests := []struct {
		name         string
		configStatus int
		loginStatus  int
		loginBody    string
		invalid      bool
		status       int
	}{
		{"wrong password", 200, 401, `{}`, true, 0},
		{"config unavailable", 503, 200, `{}`, false, 503},
		{"login error", 200, 500, `{}`, false, 500},
		{"no token in response", 200, 200, `{"username":"customer-1"}`, false, 200},
		{"not json", 200, 200, `<html>`, false, 200},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client, _ := fakeBRP(t, func(w http.ResponseWriter, c call) {
				if c.path == "/apps/383" {
					w.WriteHeader(tc.configStatus)
					return
				}
				w.WriteHeader(tc.loginStatus)
				io.WriteString(w, tc.loginBody)
			})

			_, err := client.Login(context.Background(), "u", "p")

			if tc.invalid {
				if !errors.Is(err, ErrInvalidCredentials) {
					t.Fatalf("want ErrInvalidCredentials, got %v", err)
				}
				return
			}
			var upstream *UpstreamError
			if !errors.As(err, &upstream) || upstream.Status != tc.status {
				t.Fatalf("want UpstreamError %d, got %v", tc.status, err)
			}
		})
	}
}

func TestLookupReaderResolvesAndMapsFailures(t *testing.T) {
	client, calls := fakeBRP(t, func(w http.ResponseWriter, c call) {
		switch c.query {
		case "major=123&minor=456":
			io.WriteString(w, `{"id":900002,"name":"Mock reader"}`)
		case "major=1&minor=1":
			w.WriteHeader(404)
		default:
			io.WriteString(w, `{"id":0}`)
		}
	})

	id, err := client.LookupReader(context.Background(), "123", "456", "GCLB=x")
	if err != nil || id != 900002 {
		t.Fatalf("got %d, %v", id, err)
	}
	if got := (*calls)[0]; got.path != "/passagereaders" || got.cookie != "GCLB=x" || got.auth != "" {
		t.Fatalf("unexpected lookup call %+v", got)
	}
	if _, err := client.LookupReader(context.Background(), "1", "1", ""); !errors.Is(err, ErrReaderNotFound) {
		t.Fatalf("want ErrReaderNotFound, got %v", err)
	}
	var upstream *UpstreamError
	if _, err := client.LookupReader(context.Background(), "2", "2", ""); !errors.As(err, &upstream) {
		t.Fatalf("a non-positive id must be an upstream error, got %v", err)
	}
}

func TestPassageSendsBearerCookieAndReader(t *testing.T) {
	client, calls := fakeBRP(t, func(w http.ResponseWriter, c call) {
		if c.auth != "Bearer mock-access" {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(201)
	})
	session := Session{CustomerID: "customer 1", AccessToken: "mock-access", Cookie: "GCLB=x"}

	status, err := client.Passage(context.Background(), session, 900002)

	if err != nil || status != 201 {
		t.Fatalf("got %d, %v", status, err)
	}
	got := (*calls)[0]
	if got.method != "POST" || got.path != "/customers/customer 1/passagetries" || got.cookie != "GCLB=x" {
		t.Fatalf("unexpected passage call %+v", got)
	}
	if got.body != `{"cardReader":900002,"printTicket":true}` {
		t.Fatalf("unexpected passage body %q", got.body)
	}
	session.AccessToken = "stale"
	if status, _ := client.Passage(context.Background(), session, 900002); status != 401 {
		t.Fatalf("a rejected token must surface BRP's 401, got %d", status)
	}
}

func TestConnStatsReportWhatEachRequestPaidForItsConnection(t *testing.T) {
	client, _ := fakeBRP(t, func(w http.ResponseWriter, _ call) { w.WriteHeader(201) })
	var got []ConnStats
	ctx := WithConnStats(context.Background(), func(s ConnStats) { got = append(got, s) })

	for range 2 {
		if status, err := client.Passage(ctx, Session{CustomerID: "1"}, 7); err != nil || status != 201 {
			t.Fatalf("got %d, %v", status, err)
		}
	}

	if len(got) != 2 {
		t.Fatalf("want one report per request, got %d", len(got))
	}
	if got[0].Reused || !got[1].Reused {
		t.Fatalf("the first request opens a connection and the second reuses it: %+v", got)
	}
	if _, err := client.Passage(context.Background(), Session{CustomerID: "1"}, 7); err != nil || len(got) != 2 {
		t.Fatalf("a request without a collector reports nothing: %v, %d reports", err, len(got))
	}
}

func TestADroppedConnectionIsResumedNotRenegotiated(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201) }))
	t.Cleanup(srv.Close)
	client := New(srv.URL, "383")
	transport := client.HTTPClient.Transport.(*http.Transport)
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	transport.TLSClientConfig.RootCAs = pool
	var got []ConnStats
	ctx := WithConnStats(context.Background(), func(s ConnStats) { got = append(got, s) })

	for range 2 {
		if status, err := client.Passage(ctx, Session{CustomerID: "1"}, 7); err != nil || status != 201 {
			t.Fatalf("got %d, %v", status, err)
		}
		transport.CloseIdleConnections() // what BRP's idle timeout does between two door requests
	}

	if len(got) != 2 || got[0].Reused || got[1].Reused {
		t.Fatalf("both requests must open a connection: %+v", got)
	}
	if got[0].TLSResumed || !got[1].TLSResumed {
		t.Fatalf("the second handshake must resume the first session: %+v", got)
	}
}
