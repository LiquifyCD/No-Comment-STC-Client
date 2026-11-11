// Package brp is the client for the STC/BRP member API: login, passage
// reader lookup and passage requests. It mirrors the calls the official
// mobile app makes and nothing else.
package brp

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	defaultSessionSeconds = 7 * 24 * 60 * 60
	minSessionSeconds     = 60
	maxResponseBytes      = 1 << 20
)

// Client talks to one BRP installation.
type Client struct {
	baseURL    string
	appID      string
	HTTPClient *http.Client
	Now        func() time.Time
}

// New builds a client. The transport keeps connections to BRP alive so a
// door request does not pay for a new TLS handshake, and remembers TLS
// sessions so that one BRP has dropped in the meantime is resumed, not
// negotiated from scratch.
func New(baseURL, appID string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		appID:   appID,
		HTTPClient: &http.Client{
			Timeout:       15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			Transport: &http.Transport{
				Proxy:               http.ProxyFromEnvironment,
				ForceAttemptHTTP2:   true,
				MaxIdleConns:        50,
				MaxIdleConnsPerHost: 50,
				IdleConnTimeout:     5 * time.Minute,
				TLSHandshakeTimeout: 10 * time.Second,
				TLSClientConfig:     &tls.Config{ClientSessionCache: tls.NewLRUClientSessionCache(0)},
			},
		},
		Now: time.Now,
	}
}

// ConnStats is what one request to BRP paid for its connection and how long
// BRP then took. It tells a slow BRP from a connection that had to be opened.
type ConnStats struct {
	Reused     bool  `json:"reused"`     // an open connection was used
	IdleMs     int64 `json:"idleMs"`     // how long that connection had been idle
	ConnMs     int64 `json:"connMs"`     // getting a connection: DNS, TCP and TLS when not reused
	WaitMs     int64 `json:"waitMs"`     // from having the connection to BRP's first byte
	TLSResumed bool  `json:"tlsResumed"` // a new connection resumed an earlier TLS session
}

type connStatsKey struct{}

// WithConnStats makes every request sent with ctx report its ConnStats once
// BRP has answered. Requests of one ctx may report from several goroutines.
func WithConnStats(ctx context.Context, report func(ConnStats)) context.Context {
	return context.WithValue(ctx, connStatsKey{}, report)
}

// connProbe collects the ConnStats of one request. A dial started for the
// request can finish on another goroutine, hence the lock.
type connProbe struct {
	mu      sync.Mutex
	start   time.Time
	gotConn time.Time
	stats   ConnStats
}

func (p *connProbe) trace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.stats.TLSResumed = err == nil && state.DidResume
		},
		GotConn: func(info httptrace.GotConnInfo) {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.gotConn = time.Now()
			p.stats.Reused = info.Reused
			p.stats.IdleMs = info.IdleTime.Milliseconds()
			p.stats.ConnMs = p.gotConn.Sub(p.start).Milliseconds()
		},
		GotFirstResponseByte: func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.stats.WaitMs = time.Since(p.gotConn).Milliseconds()
		},
	}
}

func (p *connProbe) result() ConnStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	stats := p.stats
	if stats.Reused {
		stats.TLSResumed = false // a handshake seen here was for a connection another request got
	}
	return stats
}

// do sends one request with the mobile app's headers. A nil body sends none.
func (c *Client) do(ctx context.Context, method, target string, body any, bearer, cookie string) (*http.Response, error) {
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(raw)
	}
	report, _ := ctx.Value(connStatsKey{}).(func(ConnStats))
	probe := &connProbe{start: time.Now()}
	if report != nil {
		ctx = httptrace.WithClientTrace(ctx, probe.trace())
	}
	req, err := http.NewRequestWithContext(ctx, method, target, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Source", "mobilityapp")
	req.Header.Set("Accept-Language", "sv-SE")
	req.Header.Set("User-Agent", "") // send none, like the client this replaces
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		// A *url.Error carries the request URL, which for a passage holds
		// the customer id. Keep the cause, drop the URL.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return nil, fmt.Errorf("brp: request failed: %w", err)
	}
	if report != nil {
		report(probe.result())
	}
	return resp, nil
}

// drain lets the connection go back to the pool.
func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseBytes))
	resp.Body.Close()
}

// firstCookie is the name=value of the first Set-Cookie header (BRP's load
// balancer affinity cookie).
func firstCookie(h http.Header) string {
	values := h.Values("Set-Cookie")
	if len(values) == 0 {
		return ""
	}
	pair, _, _ := strings.Cut(values[0], ";")
	return strings.TrimSpace(pair)
}

// Login loads the app configuration (which pins the load balancer) and then
// authenticates.
func (c *Client) Login(ctx context.Context, username, password string) (Session, error) {
	config, err := c.do(ctx, http.MethodGet, c.baseURL+"/apps/"+url.PathEscape(c.appID)+"?allowMultipleCompaniesAndBusinessUnits=true", nil, "", "")
	if err != nil {
		return Session{}, err
	}
	affinity := firstCookie(config.Header)
	drain(config)
	if config.StatusCode < 200 || config.StatusCode > 299 {
		return Session{}, &UpstreamError{Op: "app configuration", Status: config.StatusCode}
	}

	auth, err := c.do(ctx, http.MethodPost, c.baseURL+"/auth/login", map[string]string{"username": username, "password": password}, "", affinity)
	if err != nil {
		return Session{}, err
	}
	defer drain(auth)
	if auth.StatusCode == http.StatusUnauthorized {
		return Session{}, ErrInvalidCredentials
	}
	if auth.StatusCode < 200 || auth.StatusCode > 299 {
		return Session{}, &UpstreamError{Op: "login", Status: auth.StatusCode}
	}
	var data loginResponse
	if err := json.NewDecoder(io.LimitReader(auth.Body, maxResponseBytes)).Decode(&data); err != nil || data.AccessToken == "" || data.Username == "" {
		return Session{}, &UpstreamError{Op: "login response", Status: auth.StatusCode}
	}
	seconds := float64(defaultSessionSeconds)
	if data.ExpiresIn != nil {
		seconds = max(*data.ExpiresIn, minSessionSeconds)
	}
	cookie := firstCookie(auth.Header)
	if cookie == "" {
		cookie = affinity
	}
	return Session{
		CustomerID:   data.Username,
		AccessToken:  data.AccessToken,
		RefreshToken: data.RefreshToken,
		Cookie:       cookie,
		ExpiresAt:    c.Now().UnixMilli() + int64(seconds*1000),
	}, nil
}

// LookupReader resolves a beacon major/minor pair to BRP's card reader id.
func (c *Client) LookupReader(ctx context.Context, major, minor, cookie string) (int, error) {
	query := url.Values{"major": {major}, "minor": {minor}}
	resp, err := c.do(ctx, http.MethodGet, c.baseURL+"/passagereaders?"+query.Encode(), nil, "", cookie)
	if err != nil {
		return 0, err
	}
	defer drain(resp)
	if resp.StatusCode == http.StatusNotFound {
		return 0, ErrReaderNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return 0, &UpstreamError{Op: "reader lookup", Status: resp.StatusCode}
	}
	var data readerResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&data); err != nil || data.ID <= 0 {
		return 0, &UpstreamError{Op: "reader lookup response", Status: resp.StatusCode}
	}
	return data.ID, nil
}

// Passage asks BRP to let the session's customer through a card reader and
// returns BRP's HTTP status; the caller decides what a rejection means.
func (c *Client) Passage(ctx context.Context, s Session, cardReader int) (int, error) {
	target := c.baseURL + "/customers/" + url.PathEscape(s.CustomerID) + "/passagetries"
	resp, err := c.do(ctx, http.MethodPost, target, map[string]any{"cardReader": cardReader, "printTicket": true}, s.AccessToken, s.Cookie)
	if err != nil {
		return 0, err
	}
	drain(resp)
	return resp.StatusCode, nil
}
