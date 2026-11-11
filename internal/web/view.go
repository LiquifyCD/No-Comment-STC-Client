package web

import (
	"encoding/json"
	"time"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

// The JSON shapes the web UI reads. Nullable fields are pointers so they
// encode as null rather than disappearing.

type readerView struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	CreatedAt    string  `json:"createdAt"`
	LastOpenedAt *string `json:"lastOpenedAt"`
}

type eventView struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
	CreatedAt string          `json:"createdAt"`
}

type stepView struct {
	DoorName     string `json:"doorName"`
	DelaySeconds int    `json:"delaySeconds"`
}

type sequenceView struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	CreatedAt string     `json:"createdAt"`
	UpdatedAt string     `json:"updatedAt"`
	Steps     []stepView `json:"steps"`
}

func viewSequence(q store.Sequence) sequenceView {
	v := sequenceView{ID: q.ID, Name: q.Name, CreatedAt: q.CreatedAt, UpdatedAt: q.UpdatedAt, Steps: []stepView{}}
	for _, step := range q.Steps {
		v.Steps = append(v.Steps, stepView{DoorName: step.DoorName, DelaySeconds: step.DelayAfterMs / 1000})
	}
	return v
}

// ownerSessionView is the state of the upstream session device credentials
// act through. It is repeated on every device for the UI's convenience.
type ownerSessionView struct {
	SessionStatus          string  `json:"sessionStatus"`
	UpstreamExpiresAt      *string `json:"upstreamExpiresAt"`
	LastRefreshAt          *string `json:"lastRefreshAt"`
	ScheduledReauthEnabled bool    `json:"scheduledReauthEnabled"`
	NextReauthAt           *string `json:"nextReauthAt"`
	LastReauthAt           *string `json:"lastReauthAt"`
}

// viewOwnerSession describes o; found is false when the owner has none.
func viewOwnerSession(o store.OwnerSession, found bool, nowMs int64) ownerSessionView {
	if !found {
		return ownerSessionView{SessionStatus: store.StatusReauthRequired}
	}
	v := ownerSessionView{
		SessionStatus:          o.Status,
		UpstreamExpiresAt:      stampMs(o.UpstreamExpiresAt),
		LastRefreshAt:          o.LastRefreshAt,
		ScheduledReauthEnabled: o.ReauthEnabled,
		LastReauthAt:           o.LastReauthAt,
	}
	if o.UpstreamExpiresAt <= nowMs {
		v.SessionStatus = store.StatusReauthRequired
	}
	if o.NextReauthAt != nil {
		v.NextReauthAt = stampMs(*o.NextReauthAt)
	}
	return v
}

type targetView struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

type deviceView struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	ExpiresAt  *string `json:"expiresAt"`
	CreatedAt  string  `json:"createdAt"`
	UpdatedAt  string  `json:"updatedAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	RevokedAt  *string `json:"revokedAt"`
	ownerSessionView
	Targets []targetView `json:"targets"`
}

func viewDevice(d store.Device, shared ownerSessionView) deviceView {
	v := deviceView{
		ID: d.ID, Name: d.Name, ExpiresAt: deviceExpiry(d.ExpiresAt),
		CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt, LastUsedAt: d.LastUsedAt, RevokedAt: d.RevokedAt,
		ownerSessionView: shared, Targets: []targetView{},
	}
	for _, target := range d.Targets {
		v.Targets = append(v.Targets, targetView{Type: target.Type, Name: target.Name})
	}
	return v
}

// deviceExpiry is null for a credential that never expires.
func deviceExpiry(expiresAt int64) *string {
	if expiresAt >= store.NeverExpires {
		return nil
	}
	return stampMs(expiresAt)
}

func stampMs(ms int64) *string {
	v := store.Stamp(time.UnixMilli(ms))
	return &v
}
