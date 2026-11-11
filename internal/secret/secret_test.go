package secret

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func testBox(t *testing.T) *Box {
	t.Helper()
	b, err := New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSealRoundTripsAndUsesFreshNonce(t *testing.T) {
	b := testBox(t)
	in := map[string]string{"major": "123", "minor": "456"}
	first, err := b.Seal(in)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := b.Seal(in)
	if first == second {
		t.Fatal("two seals of the same value must differ")
	}
	var out map[string]string
	if err := b.Open(first, &out); err != nil {
		t.Fatal(err)
	}
	if out["major"] != "123" || out["minor"] != "456" {
		t.Fatalf("got %v", out)
	}
}

func TestOpenRejectsTamperedAndForeignValues(t *testing.T) {
	b := testBox(t)
	sealed, _ := b.Seal("value")
	raw, _ := base64.StdEncoding.DecodeString(sealed)
	raw[len(raw)-1] ^= 1
	var out string
	if err := b.Open(base64.StdEncoding.EncodeToString(raw), &out); err == nil {
		t.Fatal("tampered ciphertext must not open")
	}
	other, _ := New(bytes.Repeat([]byte{8}, 32))
	if err := other.Open(sealed, &out); err == nil {
		t.Fatal("another key must not open the value")
	}
	for _, bad := range []string{"", "not base64!", "AAAA"} {
		if err := b.Open(bad, &out); err == nil {
			t.Fatalf("%q must not open", bad)
		}
	}
}

func TestDerivedKeysAreSeparatedByPurpose(t *testing.T) {
	b := testBox(t)
	owner, token, csrf := b.OwnerID("x"), b.TokenHash("x"), b.CSRF("x")
	if owner == token || owner == csrf || token == csrf {
		t.Fatal("the same input must hash differently per purpose")
	}
	if b.OwnerID("x") != owner {
		t.Fatal("owner id must be stable")
	}
	if b.OwnerID("y") == owner {
		t.Fatal("different customers must get different owner ids")
	}
}

func TestNewRejectsWrongKeyLength(t *testing.T) {
	if _, err := New(make([]byte, 16)); err == nil {
		t.Fatal("a 16-byte key must be rejected")
	}
}

func TestLoadReadsSingleLineBase64File(t *testing.T) {
	path := filepath.Join(t.TempDir(), "master.key")
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	b, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if b.OwnerID("x") != testBox(t).OwnerID("x") {
		t.Fatal("loaded key differs from the same key built directly")
	}
	if err := os.WriteFile(path, []byte("***"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("a non-base64 key file must be rejected")
	}
}

func TestUUIDAndTokenShapes(t *testing.T) {
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(UUID()) {
		t.Fatal("not a v4 uuid")
	}
	if got := Token(32); len(got) != 43 {
		t.Fatalf("32 random bytes encode to 43 characters, got %d", len(got))
	}
	if !Equal("a", "a") || Equal("a", "b") || Equal("a", "ab") {
		t.Fatal("Equal is wrong")
	}
}
