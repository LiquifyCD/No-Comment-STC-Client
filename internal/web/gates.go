package web

import (
	"sync"
	"time"
)

// sweepSize is how many entries a gate or throttle holds before it first
// drops the expired ones.
const sweepSize = 1024

// nextSweep is the size at which a map of n live entries is swept again.
// Doubling keeps the sweeps rare however many entries stay alive.
func nextSweep(n int) int { return max(sweepSize, 2*n) }

// gate hands out short-lived exclusive slots by key: door cooldowns, device
// and client rate limits, and replay protection. The app is one process, so
// an in-memory map is exact.
type gate struct {
	mu      sync.Mutex
	until   map[string]time.Time
	sweepAt int
}

func newGate() *gate { return &gate{until: map[string]time.Time{}, sweepAt: sweepSize} }

// acquire takes the slot for ttl and reports false if it is still held.
func (g *gate) acquire(key string, ttl time.Duration, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if until, ok := g.until[key]; ok && now.Before(until) {
		return false
	}
	if len(g.until) >= g.sweepAt {
		for k, until := range g.until {
			if !now.Before(until) {
				delete(g.until, k)
			}
		}
		g.sweepAt = nextSweep(len(g.until))
	}
	g.until[key] = now.Add(ttl)
	return true
}

// held reports whether the slot is taken, without taking it.
func (g *gate) held(key string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	until, ok := g.until[key]
	return ok && now.Before(until)
}

// throttle counts failed attempts per key inside a window; it is what stops
// this app from being used to guess BRP passwords.
type throttle struct {
	mu      sync.Mutex
	window  time.Duration
	entries map[string]*attempts
	sweepAt int
}

type attempts struct {
	count int
	reset time.Time
}

func newThrottle(window time.Duration) *throttle {
	return &throttle{window: window, entries: map[string]*attempts{}, sweepAt: sweepSize}
}

// take counts one attempt for key. Once limit attempts are counted in the
// window it counts nothing and reports false. Checking and counting under one
// lock is what keeps a burst of parallel guesses inside the limit.
func (t *throttle) take(key string, limit int, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.entries) >= t.sweepAt {
		for k, e := range t.entries {
			if !now.Before(e.reset) {
				delete(t.entries, k)
			}
		}
		t.sweepAt = nextSweep(len(t.entries))
	}
	e, ok := t.entries[key]
	if !ok || !now.Before(e.reset) {
		e = &attempts{reset: now.Add(t.window)}
		t.entries[key] = e
	}
	if e.count >= limit {
		return false
	}
	e.count++
	return true
}

// release gives back an attempt that turned out not to be a failure.
func (t *throttle) release(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.entries[key]; ok && e.count > 0 {
		e.count--
	}
}

// clear forgets key after a success.
func (t *throttle) clear(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, key)
}
