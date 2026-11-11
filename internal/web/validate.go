package web

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
)

const (
	maxSequenceSteps      = 8
	maxStepDelaySeconds   = 10
	maxSequenceDelaySecs  = 30
	maxDeviceTargets      = 100
	defaultDeviceLifeDays = 30
	maxDeviceLifeDays     = 90
)

var (
	namePattern       = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$`)
	digitsPattern     = regexp.MustCompile(`^\d{1,12}$`)
	idPattern         = regexp.MustCompile(`(?i)^[0-9a-f-]{36}$`)
	requestIDPattern  = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	emailPattern      = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	credentialPattern = regexp.MustCompile(`(?i)^brpd_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$`)
)

// problem is a rejected request: the status and the message for the client.
type problem struct {
	status int
	msg    string
}

func bad(msg string) *problem { return &problem{400, msg} }

// normalize trims a name and collapses runs of whitespace.
func normalize(v any) string {
	s, _ := v.(string)
	return strings.Join(strings.Fields(s), " ")
}

func nameKey(name string) string { return strings.ToLower(name) }

// validName checks a door, sequence or device name.
func validName(v any) (name string, msg string) {
	name = normalize(v)
	switch {
	case name == "":
		return "", "Ange ett namn."
	case utf8.RuneCountInString(name) > 40:
		return "", "Namnet får vara högst 40 tecken."
	case !namePattern.MatchString(name):
		return "", "Namnet innehåller ogiltiga tecken."
	}
	return name, ""
}

func hasAny(body map[string]any, keys ...string) bool {
	for _, k := range keys {
		if _, ok := body[k]; ok {
			return true
		}
	}
	return false
}

type readerInput struct{ name, major, minor string }

func validateReaderCreation(v any) (readerInput, *problem) {
	body, ok := v.(map[string]any)
	if !ok {
		return readerInput{}, bad("Ogiltig begäran.")
	}
	if hasAny(body, "cardReader", "readerCode") {
		return readerInput{}, bad("Readerkoden styrs av servern.")
	}
	name, msg := validName(body["name"])
	if msg != "" {
		return readerInput{}, bad(msg)
	}
	if hasAny(body, "readerKey") {
		return readerInput{}, bad("Preset readers are not supported.")
	}
	major, _ := body["major"].(string)
	if !digitsPattern.MatchString(major) {
		return readerInput{}, bad("Ogiltig major.")
	}
	minor, _ := body["minor"].(string)
	if !digitsPattern.MatchString(minor) {
		return readerInput{}, bad("Ogiltig minor.")
	}
	return readerInput{name, major, minor}, nil
}

// wholeNumber accepts only a JSON number with no fraction.
func wholeNumber(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || math.Abs(f) > 1e9 {
		return 0, false
	}
	return int(f), true
}

type sequenceInput struct {
	name  string
	steps []sequenceStepInput
}

type sequenceStepInput struct {
	doorKey      string
	delayAfterMs int
}

func validateSequence(v any) (sequenceInput, *problem) {
	body, ok := v.(map[string]any)
	if !ok || hasAny(body, "customerId", "readerId", "readerIds", "major", "minor", "cardReader", "accessToken", "refreshToken", "cookie") {
		return sequenceInput{}, bad("Ogiltig begäran.")
	}
	name, msg := validName(body["name"])
	if msg != "" {
		return sequenceInput{}, bad(msg)
	}
	raw, ok := body["steps"].([]any)
	if !ok || len(raw) < 1 || len(raw) > maxSequenceSteps {
		return sequenceInput{}, bad("En sekvens måste ha 1–" + strconv.Itoa(maxSequenceSteps) + " steg.")
	}
	in := sequenceInput{name: name}
	total := 0
	for position, item := range raw {
		step, ok := item.(map[string]any)
		if !ok {
			return sequenceInput{}, bad("Ogiltigt sekvenssteg.")
		}
		if hasAny(step, "readerId", "major", "minor", "cardReader") {
			return sequenceInput{}, bad("Dörren måste anges med sparat namn.")
		}
		door, msg := validName(step["doorName"])
		if msg != "" {
			return sequenceInput{}, bad("Ogiltigt dörrnamn.")
		}
		delay, ok := wholeNumber(step["delaySeconds"])
		if !ok || delay < 0 || delay > maxStepDelaySeconds {
			return sequenceInput{}, bad("Väntetiden måste vara 0–" + strconv.Itoa(maxStepDelaySeconds) + " sekunder.")
		}
		if position == len(raw)-1 {
			delay = 0 // nothing to wait for after the last door
		}
		total += delay
		in.steps = append(in.steps, sequenceStepInput{nameKey(door), delay * 1000})
	}
	if total > maxSequenceDelaySecs {
		return sequenceInput{}, bad("Total väntetid får vara högst " + strconv.Itoa(maxSequenceDelaySecs) + " sekunder.")
	}
	return in, nil
}

type deviceInput struct {
	name    string
	never   bool
	days    int
	targets []store.DeviceTarget
}

func validateDevice(v any) (deviceInput, *problem) {
	body, ok := v.(map[string]any)
	if !ok {
		return deviceInput{}, bad("Invalid request.")
	}
	in := deviceInput{name: normalize(body["name"]), days: defaultDeviceLifeDays}
	if !namePattern.MatchString(in.name) {
		return deviceInput{}, bad("Invalid device name.")
	}
	switch expiry := body["expiresInDays"].(type) {
	case nil:
	case string:
		if expiry == "never" {
			in.never = true
			break
		}
		days, err := strconv.Atoi(strings.TrimSpace(expiry))
		if err != nil {
			return deviceInput{}, bad("Expiry must be never or 1-90 days.")
		}
		in.days = days
	default:
		days, ok := wholeNumber(expiry)
		if !ok {
			return deviceInput{}, bad("Expiry must be never or 1-90 days.")
		}
		in.days = days
	}
	if !in.never && (in.days < 1 || in.days > maxDeviceLifeDays) {
		return deviceInput{}, bad("Expiry must be never or 1-90 days.")
	}
	if body["targets"] == nil {
		return in, nil
	}
	raw, ok := body["targets"].([]any)
	if !ok || len(raw) > maxDeviceTargets {
		return deviceInput{}, bad("Invalid target allowlist.")
	}
	for _, item := range raw {
		target, _ := item.(map[string]any)
		kind, _ := target["type"].(string)
		id, _ := target["id"].(string)
		if (kind != "door" && kind != "sequence") || !idPattern.MatchString(id) {
			return deviceInput{}, bad("Invalid target allowlist.")
		}
		in.targets = append(in.targets, store.DeviceTarget{Type: kind, ID: id})
	}
	return in, nil
}

// targetRef is what an open-door request names: one door or one sequence.
type targetRef struct{ kind, key string }

// namedTarget reads doorName/sequenceName; exactly one must be given.
func namedTarget(body map[string]any) (targetRef, *problem) {
	door, sequence := normalize(body["doorName"]), normalize(body["sequenceName"])
	if (door != "") == (sequence != "") {
		return targetRef{}, bad("Provide exactly one doorName or sequenceName.")
	}
	ref := targetRef{"door", door}
	if door == "" {
		ref = targetRef{"sequence", sequence}
	}
	if !namePattern.MatchString(ref.key) {
		return targetRef{}, bad("Invalid target name.")
	}
	ref.key = nameKey(ref.key)
	return ref, nil
}

// validateDeviceTarget is the body of a device credential request: nothing
// but the target name is accepted.
func validateDeviceTarget(v any) (targetRef, *problem) {
	body, ok := v.(map[string]any)
	if !ok {
		return targetRef{}, bad("Invalid request.")
	}
	for key := range body {
		if key != "doorName" && key != "sequenceName" {
			return targetRef{}, bad("Invalid request.")
		}
	}
	return namedTarget(body)
}

type legacyInput struct {
	email, password string
	target          targetRef
}

// validateLegacyOpen is the body of an email+password open-door request.
func validateLegacyOpen(v any) (legacyInput, *problem) {
	body, ok := v.(map[string]any)
	if !ok || hasAny(body, "reader", "readerId", "major", "minor", "cardReader", "readerCode", "customerId", "accessToken", "refreshToken", "cookie") {
		return legacyInput{}, bad("Invalid request.")
	}
	email, _ := body["email"].(string)
	if len(email) > 254 || !emailPattern.MatchString(strings.TrimSpace(email)) {
		return legacyInput{}, bad("Invalid email.")
	}
	password, _ := body["password"].(string)
	if len(password) < 1 || len(password) > 256 {
		return legacyInput{}, bad("Invalid password.")
	}
	target, p := namedTarget(body)
	if p != nil {
		return legacyInput{}, p
	}
	return legacyInput{strings.TrimSpace(email), password, target}, nil
}

// parseCredential splits a device credential into its id and secret.
func parseCredential(v string) (id, deviceSecret string, ok bool) {
	m := credentialPattern.FindStringSubmatch(v)
	if m == nil {
		return "", "", false
	}
	return strings.ToLower(m[1]), m[2], true
}
