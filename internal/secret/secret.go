// Package secret holds the STC client's key material. One master key is
// split with HKDF into independent keys for encryption, owner ids, device
// token hashes and CSRF tokens, so a value produced for one purpose can never
// stand in for another.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

const keyLen = 32

// Box seals stored secrets and derives the keyed identifiers.
type Box struct {
	aead                     cipher.AEAD
	ownerKey, tokenKey, csrf []byte
}

// Load reads the single-line base64 master key file.
func Load(path string) (*Box, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	master, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, fmt.Errorf("%s: not base64", path)
	}
	return New(master)
}

// New derives the working keys from a 32-byte master key.
func New(master []byte) (*Box, error) {
	if len(master) != keyLen {
		return nil, errors.New("master key must be 32 bytes")
	}
	derive := func(purpose string) ([]byte, error) {
		return hkdf.Key(sha256.New, master, nil, "stc-client/"+purpose, keyLen)
	}
	enc, err := derive("encryption")
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(enc)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	b := &Box{aead: aead}
	if b.ownerKey, err = derive("owner-id"); err != nil {
		return nil, err
	}
	if b.tokenKey, err = derive("device-token"); err != nil {
		return nil, err
	}
	if b.csrf, err = derive("csrf"); err != nil {
		return nil, err
	}
	return b, nil
}

// Seal encrypts v as JSON with AES-256-GCM under a fresh nonce.
func (b *Box) Seal(v any) (string, error) {
	plain, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b.aead.Seal(nonce, nonce, plain, nil)), nil
}

// Open decrypts a Seal result into v.
func (b *Box) Open(sealed string, v any) error {
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil || len(raw) < b.aead.NonceSize() {
		return errors.New("invalid sealed value")
	}
	n := b.aead.NonceSize()
	plain, err := b.aead.Open(nil, raw[:n], raw[n:], nil)
	if err != nil {
		return errors.New("invalid sealed value")
	}
	return json.Unmarshal(plain, v)
}

func mac(key []byte, msg string) string {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// OwnerID is the stable pseudonym every row is scoped by; the BRP customer
// id itself is only ever stored sealed.
func (b *Box) OwnerID(customerID string) string { return mac(b.ownerKey, customerID) }

// TokenHash is what is stored for a device credential's secret.
func (b *Box) TokenHash(deviceSecret string) string { return mac(b.tokenKey, deviceSecret) }

// CSRF is the token bound to one browser session.
func (b *Box) CSRF(sessionID string) string { return mac(b.csrf, sessionID) }

// Equal compares two strings in constant time.
func Equal(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// Token returns n random bytes, base64url without padding.
func Token(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err) // crypto/rand does not fail on supported platforms
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// UUID returns a random version 4 UUID.
func UUID() string {
	var u [16]byte
	if _, err := rand.Read(u[:]); err != nil {
		panic(err)
	}
	u[6] = u[6]&0x0f | 0x40
	u[8] = u[8]&0x3f | 0x80
	h := hex.EncodeToString(u[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// SessionKey is the stored lookup key for a browser session id.
func SessionKey(sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:])
}
