package brp

import (
	"errors"
	"fmt"
)

// Session is one authenticated BRP session. It is stored sealed and never
// leaves the server.
type Session struct {
	CustomerID   string `json:"customerId"`
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken,omitempty"`
	Cookie       string `json:"upstreamCookie,omitempty"`
	ExpiresAt    int64  `json:"expiresAt"` // Unix milliseconds
}

// ErrInvalidCredentials is BRP rejecting the username or password.
var ErrInvalidCredentials = errors.New("brp: invalid credentials")

// ErrReaderNotFound is BRP not knowing the major/minor pair.
var ErrReaderNotFound = errors.New("brp: reader not found")

// UpstreamError is any other failed BRP call. It carries only the status,
// never the response body.
type UpstreamError struct {
	Op     string
	Status int
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("brp: %s failed (HTTP %d)", e.Op, e.Status)
}

type loginResponse struct {
	AccessToken  string   `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	Username     string   `json:"username"`
	ExpiresIn    *float64 `json:"expires_in"`
}

type readerResponse struct {
	ID int `json:"id"`
}
