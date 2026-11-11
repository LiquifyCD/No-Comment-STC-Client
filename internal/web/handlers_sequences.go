package web

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

func (s *Server) listSequences(w http.ResponseWriter, r *http.Request, a *active) {
	sequences, err := s.st.Sequences(r.Context(), a.owner)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := []sequenceView{}
	for _, q := range sequences {
		out = append(out, viewSequence(q))
	}
	writeJSON(w, http.StatusOK, map[string]any{"sequences": out})
}

// saveSequence creates a sequence (POST) or replaces one (PATCH).
func (s *Server) saveSequence(w http.ResponseWriter, r *http.Request, a *active) {
	body, err := readJSON(w, r, maxBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Ogiltig JSON.")
		return
	}
	in, p := validateSequence(body)
	if p != nil {
		writeProblem(w, p)
		return
	}
	ctx := r.Context()
	steps, p, err := s.sequenceSteps(ctx, a.owner, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if p != nil {
		writeProblem(w, p)
		return
	}
	update := r.Method == http.MethodPatch
	id, status := secret.UUID(), http.StatusCreated
	if update {
		id, status = r.PathValue("id"), http.StatusOK
	}
	err = s.st.SaveSequence(ctx, a.owner, id, update, in.name, nameKey(in.name), steps, store.Stamp(s.now()))
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "Sekvensen hittades inte.")
		return
	case errors.Is(err, store.ErrConflict):
		writeErr(w, http.StatusConflict, "En sekvens med samma namn finns redan.")
		return
	case err != nil:
		s.fail(w, r, err)
		return
	}
	saved, err := s.st.Sequences(ctx, a.owner)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for _, q := range saved {
		if q.ID == id {
			writeJSON(w, status, map[string]any{"sequence": viewSequence(q)})
			return
		}
	}
	s.fail(w, r, errors.New("saved sequence is missing"))
}

// sequenceSteps turns validated door names into the owner's saved doors.
func (s *Server) sequenceSteps(ctx context.Context, owner string, in sequenceInput) ([]store.SequenceStep, *problem, error) {
	steps := make([]store.SequenceStep, 0, len(in.steps))
	for _, step := range in.steps {
		ids, err := s.st.UsableReaderIDs(ctx, owner, step.doorKey)
		if err != nil {
			return nil, nil, err
		}
		switch len(ids) {
		case 0:
			return nil, &problem{http.StatusNotFound, "En sparad dörr hittades inte."}, nil
		case 1:
		default:
			return nil, &problem{http.StatusConflict, "Dörrnamnet är tvetydigt."}, nil
		}
		steps = append(steps, store.SequenceStep{ReaderID: ids[0], DelayAfterMs: step.delayAfterMs})
	}
	return steps, nil, nil
}

func (s *Server) deleteSequence(w http.ResponseWriter, r *http.Request, a *active) {
	body, err := readJSON(w, r, maxBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Ogiltig JSON.")
		return
	}
	if !confirmed(body) {
		writeErr(w, http.StatusBadRequest, "Borttagningen måste bekräftas.")
		return
	}
	err = s.st.DeleteSequence(r.Context(), a.owner, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "Sekvensen hittades inte.")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) runSequence(w http.ResponseWriter, r *http.Request, a *active) {
	if !s.cfg.PassageEnabled {
		writeErr(w, http.StatusServiceUnavailable, "Passagefunktionen är inte aktiverad.")
		return
	}
	body, err := readJSON(w, r, maxBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Ogiltig JSON.")
		return
	}
	fields, _ := body.(map[string]any)
	requestID, _ := fields["requestId"].(string)
	if !confirmed(body) || !requestIDPattern.MatchString(requestID) {
		writeErr(w, http.StatusBadRequest, "Ogiltig begäran.")
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	steps, err := s.st.SequenceSteps(ctx, a.owner, id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "Sekvensen hittades inte eller saknar giltiga steg.")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.gates.acquire("replay-sequence:"+a.key+":"+id+":"+strings.ToLower(requestID), replayWindow, s.now()) {
		writeErr(w, http.StatusConflict, "Begäran har redan behandlats.")
		return
	}
	res := s.runSteps(ctx, a.owner, a.upstream, steps, "sequence_passage")
	stamp := store.Stamp(s.now())
	s.recordRun(ctx, "sequence", id, a.owner, res, stamp)
	if !res.ok {
		writeJSON(w, res.status, map[string]any{"error": res.msg, "failedStep": res.failedStep, "completedSteps": res.completed, "timestamp": stamp})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "completedSteps": res.completed, "timestamp": stamp, "message": "Sekvensen slutfördes."})
}

func (s *Server) getDefault(w http.ResponseWriter, r *http.Request, a *active) {
	selection, err := s.st.DefaultSelection(r.Context(), a.owner)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"defaultSelection": selection})
}

func (s *Server) putDefault(w http.ResponseWriter, r *http.Request, a *active) {
	body, err := readJSON(w, r, maxBody)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Ogiltig JSON.")
		return
	}
	fields, _ := body.(map[string]any)
	kind, _ := fields["type"].(string)
	if kind != "door" && kind != "sequence" {
		writeErr(w, http.StatusBadRequest, "Ogiltig standardtyp.")
		return
	}
	name, msg := validName(fields["name"])
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	ctx := r.Context()
	ids, err := s.st.DefaultCandidates(ctx, a.owner, kind, nameKey(name))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	switch len(ids) {
	case 0:
		writeErr(w, http.StatusNotFound, "Valet hittades inte.")
		return
	case 1:
	default:
		writeErr(w, http.StatusConflict, "Namnet är tvetydigt.")
		return
	}
	if err := s.st.SetDefault(ctx, a.owner, kind, ids[0], store.Stamp(s.now())); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"defaultSelection": store.Selection{Type: kind, ID: ids[0]}})
}
