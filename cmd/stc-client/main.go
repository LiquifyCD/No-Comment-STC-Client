// Command stc-client serves the STC door client: the web app and the
// open-door API for automations. It is meant to listen on loopback behind a
// TLS-terminating reverse proxy such as `tailscale serve`.
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/LiquifyCD/No-Comment-STC-Client/internal/brp"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/secret"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/store"
	"github.com/LiquifyCD/No-Comment-STC-Client/internal/web"
)

// minLegacyKeyLen keeps a guessable shared key from enabling the legacy API.
const minLegacyKeyLen = 32

func main() {
	if err := serve(); err != nil {
		log.Fatalf("stc-client: %v", err)
	}
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// optionalLine reads a single-line file. A missing file means the feature it
// configures is off.
func optionalLine(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

func config() (web.Config, error) {
	var cfg web.Config
	for _, o := range strings.Split(env("STC_ORIGIN", ""), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.Origins = append(cfg.Origins, strings.TrimRight(o, "/"))
		}
	}
	enabled, err := strconv.ParseBool(env("STC_PASSAGE_ENABLED", "false"))
	if err != nil {
		return cfg, fmt.Errorf("STC_PASSAGE_ENABLED: %w", err)
	}
	cfg.PassageEnabled = enabled

	keyFile := env("STC_LEGACY_API_KEY_FILE", "/etc/stc-client/legacy-api-key")
	if cfg.LegacyAPIKey, err = optionalLine(keyFile); err != nil {
		return cfg, err
	}
	if cfg.LegacyAPIKey != "" && len(cfg.LegacyAPIKey) < minLegacyKeyLen {
		return cfg, fmt.Errorf("%s: the key must be at least %d characters", keyFile, minLegacyKeyLen)
	}

	readerFile := env("STC_DEFAULT_READER_FILE", "/etc/stc-client/default-reader")
	reader, err := optionalLine(readerFile)
	if err != nil {
		return cfg, err
	}
	if reader != "" {
		if cfg.DefaultReader, err = strconv.Atoi(reader); err != nil || cfg.DefaultReader <= 0 {
			return cfg, fmt.Errorf("%s: want one positive reader code", readerFile)
		}
	}
	return cfg, nil
}

func serve() error {
	cfg, err := config()
	if err != nil {
		return err
	}
	box, err := secret.Load(env("STC_KEY_FILE", "/etc/stc-client/master.key"))
	if err != nil {
		return fmt.Errorf("master key: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	st, err := store.Open(ctx, env("STC_DB", "/srv/stc-client/stc.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	client := brp.New(env("STC_BRP_BASE_URL", "https://stc.brpsystems.com/brponline/api/ver3"), env("STC_BRP_APP_ID", "383"))
	app := web.New(st, box, client, cfg)
	go app.RunMaintenance(ctx)

	srv := &http.Server{
		Addr:              env("STC_LISTEN", ":8796"),
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// A sequence may wait 30 seconds between its doors, on top of one
		// upstream call for each.
		WriteTimeout: 2 * time.Minute,
		IdleTimeout:  2 * time.Minute,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Printf("stc-client listening on %s (door opening enabled: %t)", srv.Addr, cfg.PassageEnabled)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
