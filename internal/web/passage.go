package web

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

// readerConfig is the sealed beacon pair a door was saved with.
type readerConfig struct {
	Major string `json:"major"`
	Minor string `json:"minor"`
}

func (s *Server) cachedCode(id string) (int, bool) {
	s.codesMu.Lock()
	defer s.codesMu.Unlock()
	code, ok := s.codes[id]
	return code, ok
}

func (s *Server) cacheCode(id string, code int) {
	s.codesMu.Lock()
	defer s.codesMu.Unlock()
	s.codes[id] = code
}

func (s *Server) evictCode(id string) {
	s.codesMu.Lock()
	defer s.codesMu.Unlock()
	delete(s.codes, id)
}

// cardReader is the BRP reader code of a usable door: the seeded one, or the
// one BRP gives for the door's beacon pair. The lookup result is cached, so
// only the first request for a door pays for it.
func (s *Server) cardReader(ctx context.Context, rd store.Reader, cookie string) (int, error) {
	if rd.Config == nil {
		return rd.CardReader, nil
	}
	if code, ok := s.cachedCode(rd.ID); ok {
		return code, nil
	}
	var cfg readerConfig
	if err := s.box.Open(*rd.Config, &cfg); err != nil {
		return 0, err
	}
	code, err := s.brp.LookupReader(ctx, cfg.Major, cfg.Minor, cookie)
	if err != nil {
		return 0, err
	}
	s.cacheCode(rd.ID, code)
	return code, nil
}

// attempt is one passage request as recorded in a door's audit log.
type attempt struct {
	auditID, timestamp string
	upstream           int // BRP's HTTP status; 0 if BRP was unreachable
	ok                 bool
}

// rejected is the status a refused attempt is reported with.
func (a attempt) rejected() int {
	if a.upstream == http.StatusUnauthorized {
		return http.StatusUnauthorized
	}
	return http.StatusBadGateway
}

// tryPassage asks BRP to open a door and records the outcome. The audit row
// is written even if the caller has gone away.
func (s *Server) tryPassage(ctx context.Context, owner string, up brp.Session, rd store.Reader, code int, eventType string) (attempt, error) {
	status, err := s.brp.Passage(ctx, up, code)
	if err != nil {
		log.Printf("passage: %v", err)
		status = 0
	}
	a := attempt{auditID: secret.UUID(), timestamp: store.Stamp(s.now()), upstream: status, ok: status >= 200 && status <= 299}
	outcome := "accepted"
	if !a.ok {
		outcome = "rejected"
		s.evictCode(rd.ID) // the code may be stale; look it up again next time
	}
	data, err := json.Marshal(map[string]any{"outcome": outcome, "status": status})
	if err != nil {
		return a, err
	}
	return a, s.st.AddReaderEvent(context.WithoutCancel(ctx), a.auditID, rd.ID, owner, eventType, string(data), a.timestamp)
}

// outcome is the result of opening one door or running a list of them.
type outcome struct {
	ok         bool
	status     int // for the client when !ok
	msg        string
	failedStep int
	completed  int
}

func (o outcome) word() string {
	if o.ok {
		return "accepted"
	}
	return "rejected"
}

// openStoredReader opens one saved door for owner through an upstream
// session. It is the step of sequences and of both open-door APIs.
func (s *Server) openStoredReader(ctx context.Context, owner string, up brp.Session, readerID, eventType string) outcome {
	internal := outcome{status: http.StatusInternalServerError, msg: unexpected}
	rd, err := s.st.UsableReader(ctx, owner, readerID)
	if errors.Is(err, store.ErrNotFound) {
		return outcome{status: http.StatusNotFound, msg: "Dörren hittades inte."}
	}
	if err != nil {
		log.Printf("open door: %v", err)
		return internal
	}
	code, err := s.cardReader(ctx, rd, up.Cookie)
	if errors.Is(err, brp.ErrReaderNotFound) {
		return outcome{status: http.StatusNotFound, msg: "Dörren hittades inte hos BRP."}
	}
	if err != nil {
		log.Printf("reader lookup: %v", err)
		return outcome{status: http.StatusBadGateway, msg: "Dörruppslagningen misslyckades."}
	}
	if !s.gates.acquire("door:"+owner+":"+rd.ID, doorCooldown, s.now()) {
		return outcome{status: http.StatusTooManyRequests, msg: "Vänta 1 sekund innan nästa försök."}
	}
	a, err := s.tryPassage(ctx, owner, up, rd, code, eventType)
	if err != nil {
		log.Printf("open door: %v", err)
		return internal
	}
	if !a.ok {
		return outcome{status: a.rejected(), msg: "Dörrförsöket avvisades."}
	}
	return outcome{ok: true}
}

// runSteps opens doors in order, pausing between them, and stops at the
// first one that fails. Steps with no pause between them are asked for
// together, so a door after a failed one in that run has been tried too.
func (s *Server) runSteps(ctx context.Context, owner string, up brp.Session, steps []store.SequenceStep, eventType string) outcome {
	for start := 0; start < len(steps); {
		end := start
		for end < len(steps)-1 && steps[end].DelayAfterMs <= 0 {
			end++
		}
		results := make([]outcome, end-start+1)
		var wg sync.WaitGroup
		for i := range results {
			wg.Go(func() {
				results[i] = s.openStoredReader(ctx, owner, up, steps[start+i].ReaderID, eventType)
			})
		}
		wg.Wait()
		for i, res := range results {
			if !res.ok {
				res.failedStep, res.completed = start+i+1, start+i
				return res
			}
		}
		if end == len(steps)-1 {
			break
		}
		if err := s.sleep(ctx, time.Duration(steps[end].DelayAfterMs)*time.Millisecond); err != nil {
			// Nobody is waiting any more: do not open further doors.
			return outcome{status: http.StatusBadGateway, msg: "Dörrförsöket avvisades.", failedStep: end + 2, completed: end + 1}
		}
		start = end + 1
	}
	return outcome{ok: true, completed: len(steps)}
}

// resolveTarget finds what an open-door request names. A nil problem and
// nil error mean id and steps are set.
func (s *Server) resolveTarget(ctx context.Context, owner string, ref targetRef) (id string, steps []store.SequenceStep, p *problem, err error) {
	var ids []string
	if ref.kind == "door" {
		ids, err = s.st.UsableReaderIDs(ctx, owner, ref.key)
	} else {
		ids, err = s.st.SequenceIDs(ctx, owner, ref.key)
	}
	if err != nil {
		return "", nil, nil, err
	}
	missing := &problem{http.StatusNotFound, "Target not found."}
	switch len(ids) {
	case 0:
		return "", nil, missing, nil
	case 1:
	default:
		return "", nil, &problem{http.StatusConflict, "Target name is ambiguous."}, nil
	}
	if ref.kind == "door" {
		return ids[0], []store.SequenceStep{{ReaderID: ids[0]}}, nil, nil
	}
	steps, err = s.st.SequenceSteps(ctx, owner, ids[0])
	if errors.Is(err, store.ErrNotFound) {
		return "", nil, missing, nil
	}
	return ids[0], steps, nil, err
}

// recordRun notes a sequence run in its history. Doors are recorded per
// attempt by tryPassage.
func (s *Server) recordRun(ctx context.Context, kind, sequenceID, owner string, res outcome, stamp string) {
	if kind != "sequence" {
		return
	}
	if err := s.st.AddSequenceEvent(context.WithoutCancel(ctx), secret.UUID(), sequenceID, owner, res.word(), res.completed, stamp); err != nil {
		log.Printf("sequence event: %v", err)
	}
}
