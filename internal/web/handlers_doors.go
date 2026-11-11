package web

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

const readerEventLimit = 20

func (s *Server) listReaders(w http.ResponseWriter, r *http.Request, a *active) {
	ctx := r.Context()
	if s.cfg.DefaultReader > 0 {
		if err := s.st.SeedDefaultReader(ctx, secret.UUID(), a.owner, s.cfg.DefaultReader, store.Stamp(s.now())); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	readers, err := s.st.Readers(ctx, a.owner)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := []readerView{}
	for _, rd := range readers {
		out = append(out, readerView{rd.ID, rd.Name, rd.CreatedAt, rd.LastOpenedAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"readers": out})
}

func (s *Server) createReader(w http.ResponseWriter, r *http.Request, a *active) {
	body, err := readJSON(w, r, maxBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Ogiltig begäran.")
		return
	}
	in, p := validateReaderCreation(body)
	if p != nil {
		writeProblem(w, p)
		return
	}
	sealed, err := s.box.Seal(readerConfig{in.major, in.minor})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	now := store.Stamp(s.now())
	id, err := s.st.SaveConfiguredReader(r.Context(), secret.UUID(), a.owner, in.name, nameKey(in.name), sealed, now)
	if errors.Is(err, store.ErrConflict) {
		writeErr(w, http.StatusConflict, "En läsare med samma namn finns redan.")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"reader": readerView{id, in.name, now, &now}})
}

func (s *Server) getReader(w http.ResponseWriter, r *http.Request, a *active) {
	ctx := r.Context()
	rd, err := s.st.Reader(ctx, a.owner, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "Läsaren hittades inte.")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	now := store.Stamp(s.now())
	if err := s.st.TouchReader(ctx, a.owner, rd.ID, now); err != nil {
		s.fail(w, r, err)
		return
	}
	events, err := s.st.ReaderEvents(ctx, a.owner, rd.ID, readerEventLimit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := []eventView{}
	for _, e := range events {
		out = append(out, eventView{e.ID, e.Type, json.RawMessage(e.DataJSON), e.CreatedAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"reader": readerView{rd.ID, rd.Name, rd.CreatedAt, &now}, "events": out})
}

func (s *Server) renameReader(w http.ResponseWriter, r *http.Request, a *active) {
	body, err := readJSON(w, r, maxBody)
	fields, isObject := body.(map[string]any)
	if err != nil || !isObject {
		writeErr(w, http.StatusBadRequest, "Ogiltig begäran.")
		return
	}
	name, msg := validName(fields["name"])
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	id := r.PathValue("id")
	switch err := s.st.RenameReader(r.Context(), a.owner, id, name, nameKey(name)); {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "Läsaren hittades inte.")
	case errors.Is(err, store.ErrConflict):
		writeErr(w, http.StatusConflict, "En läsare med samma namn finns redan.")
	case err != nil:
		s.fail(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"reader": map[string]string{"id": id, "name": name}})
	}
}

// confirmed reports whether a body carries the explicit confirmation that
// destructive and door-opening requests need.
func confirmed(body any) bool {
	fields, _ := body.(map[string]any)
	yes, _ := fields["confirmed"].(bool)
	return yes
}

func (s *Server) deleteReader(w http.ResponseWriter, r *http.Request, a *active) {
	body, err := readJSON(w, r, maxBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Ogiltig begäran.")
		return
	}
	if !confirmed(body) {
		writeErr(w, http.StatusBadRequest, "Borttagningen måste bekräftas.")
		return
	}
	id := r.PathValue("id")
	err = s.st.DeleteReader(r.Context(), a.owner, id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "Läsaren hittades inte.")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.evictCode(id)
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// passage opens one door for the signed-in browser, through that browser's
// own upstream session.
func (s *Server) passage(w http.ResponseWriter, r *http.Request, a *active) {
	ctx := r.Context()
	rd, err := s.st.Reader(ctx, a.owner, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "Läsaren hittades inte.")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if rd.Config == nil && rd.CardReader <= 0 {
		writeErr(w, http.StatusServiceUnavailable, "Ingen godkänd kortläsare är konfigurerad.")
		return
	}
	body, err := readJSON(w, r, maxBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Ogiltig JSON.")
		return
	}
	requestID, p := s.validatePassage(body)
	if p != nil {
		writeProblem(w, p)
		return
	}
	replay := "replay:" + a.key + ":" + rd.ID + ":" + requestID
	if s.gates.held(replay, s.now()) {
		writeErr(w, http.StatusConflict, "Begäran har redan behandlats.")
		return
	}
	code, err := s.cardReader(ctx, rd, a.upstream.Cookie)
	if errors.Is(err, brp.ErrReaderNotFound) {
		writeErr(w, http.StatusNotFound, "Läsaren hittades inte hos BRP.")
		return
	}
	if err != nil {
		log.Printf("reader lookup: %v", err)
		writeErr(w, http.StatusBadGateway, "Läsaruppslagningen misslyckades.")
		return
	}
	now := s.now()
	if !s.gates.acquire("door:"+a.owner+":"+rd.ID, doorCooldown, now) {
		writeErr(w, http.StatusTooManyRequests, "Vänta 1 sekund innan nästa försök.")
		return
	}
	s.gates.acquire(replay, replayWindow, now)

	res, err := s.tryPassage(ctx, a.owner, a.upstream, rd, code, "passage")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	outcome := "accepted"
	if !res.ok {
		outcome = "rejected"
	}
	logEvent("passage_attempt", map[string]any{"auditId": res.auditID, "readerId": rd.ID, "timestamp": res.timestamp, "outcome": outcome, "status": res.upstream})
	if !res.ok {
		writeJSON(w, res.rejected(), map[string]any{"error": "Passageförsöket avvisades.", "auditId": res.auditID, "timestamp": res.timestamp})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "auditId": res.auditID, "timestamp": res.timestamp, "message": "Passageförsöket skickades."})
}

// validatePassage checks the body of a browser passage request and returns
// its request id.
func (s *Server) validatePassage(body any) (string, *problem) {
	fields, ok := body.(map[string]any)
	switch {
	case !ok:
		return "", bad("Ogiltig begäran.")
	case hasAny(fields, "customerId"):
		return "", bad("Kund-ID får inte skickas från klienten.")
	case hasAny(fields, "cardReader"):
		return "", bad("Kortläsare styrs av servern.")
	case !s.cfg.PassageEnabled:
		return "", &problem{http.StatusServiceUnavailable, "Passagefunktionen är inte aktiverad."}
	case !confirmed(body):
		return "", bad("Passagen måste bekräftas.")
	}
	requestID, _ := fields["requestId"].(string)
	if !requestIDPattern.MatchString(requestID) {
		return "", bad("Ogiltigt request-ID.")
	}
	return strings.ToLower(requestID), nil
}
