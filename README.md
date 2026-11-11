# No-Comment STC Client

> [!WARNING]
> This is an unofficial third-party client. It is not affiliated with, endorsed by, or supported by STC, BRP Systems, or their affiliates. Use it only with your own account and readers/facilities you are explicitly authorized to operate. You assume all risk arising from use.

A small self-hosted client for authenticated door operations, saved doors, sequences, and device credentials. This repository is **source-available, not open source**. Personal, noncommercial, unmodified use is permitted under the [No-Comment Personal Use License](LICENSE); modification, redistribution, sale, sublicensing, and commercial use are prohibited.

## What it does

STC gym doors are normally opened from the official app, which asks BRP (the membership system behind STC) to let the signed-in member through a specific door reader. This client makes the same request for you, so a door can be opened with one tap in a small web app or with one HTTP request from an automation such as an iPhone Shortcut.

- **Doors**: a saved door is a name plus the `major`/`minor` beacon values of its reader.
- **Sequences**: up to 8 saved doors opened in order, with up to 10 seconds between steps (30 seconds in total).
- **Device credentials**: a token for one automation, so the automation never holds your STC password.

## How it works

```text
Browser / Home Screen app ──cookie session──┐
                                            ├──► stc-client ──► BRP API ──► door reader
iPhone Shortcut ──device credential─────────┘
```

1. You sign in with your own STC/BRP login. The server passes the password to BRP and keeps only the session BRP returns, encrypted with AES-GCM. The browser gets an `HttpOnly` cookie and never sees the BRP tokens.
2. When you open a door, the server resolves the saved door's reader with BRP and sends one passage request on your behalf. A sequence does this step by step and stops at the first failure.
3. An automation authenticates with a device credential (`brpd_<id>.<secret>`). The server stores only a keyed hash of it and uses your stored BRP session.
4. BRP sessions last about a week. Sign in again when a device reports that it needs reauthorization, or turn on **automatic renewal** in **Devices**: the login is then stored encrypted and the session is renewed every three days.

Each account sees only its own doors, sequences and devices.

> [!NOTE]
> Up to v1.0.0 this repository was a Cloudflare Worker with an Expo app. That code is still in the Git history; this Go server replaces it and keeps the same routes and API.

## Stack

- **Server:** Go 1.26, standard library `net/http`, SQLite through [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) (pure Go, no cgo). One static binary.
- **Web app:** plain HTML, CSS and JavaScript with no build step, embedded in the binary and installable as a Home Screen app (PWA). Light and dark themes.
- **Deployment:** a small unprivileged container (read-only root filesystem, no capabilities) behind any TLS-terminating reverse proxy.

```text
cmd/stc-client/        entry point and configuration
internal/brp/          BRP API client (login, reader lookup, passage)
internal/store/        SQLite schema and queries
internal/secret/       AES-GCM sealing, keyed hashes, tokens
internal/web/          HTTP handlers, auth, validation, rate limits
internal/web/static/   the web app
docs/API.md            open-door API reference
```

## The app

Three tabs: **Doors** (the default door as a large Open button, every other door and sequence as a row with its own Open), **Sequences** (the list and the step editor) and **Devices** (the BRP session, automatic renewal and device credentials, each of which can be renamed, reauthorized, rotated or revoked). The interface is in English; some validation messages from the server are in Swedish.

## Running it

The app listens on plain HTTP and expects a TLS-terminating reverse proxy in front of it (for example `tailscale serve`). Browser sessions use `Secure` cookies, so it must be reached over HTTPS.

1. Create the master key. It encrypts stored sessions and beacon values; losing or replacing it makes the database unreadable.

   ```bash
   mkdir -p secrets data
   head -c 32 /dev/urandom | base64 > secrets/master.key
   sudo chown -R 10001:10001 data && sudo chgrp -R 10001 secrets && chmod 0750 secrets && chmod 0440 secrets/master.key
   ```

2. Copy `docker-compose.example.yml` to `docker-compose.yml`, set `STC_ORIGIN` to the HTTPS URL the app will be served on, and run `docker compose up -d --build`.
3. Check it: `curl -s http://127.0.0.1:8796/healthz` returns `{"ok":true}`.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `STC_ORIGIN` | (none) | Comma-separated browser origins of the app. Writes from any other origin are refused. |
| `STC_PASSAGE_ENABLED` | `false` | `true` turns door opening on; `false` makes every door request answer 503. |
| `STC_LISTEN` | `:8796` | Listen address. |
| `STC_DB` | `/srv/stc-client/stc.db` | SQLite database path. |
| `STC_KEY_FILE` | `/etc/stc-client/master.key` | Master key (required). |
| `STC_LEGACY_API_KEY_FILE` | `/etc/stc-client/legacy-api-key` | Optional, at least 32 characters. Present turns on the email+password form of `/api/open-door`. |
| `STC_DEFAULT_READER_FILE` | `/etc/stc-client/default-reader` | Optional BRP reader code. Present gives every account a "Main entrance" door on first use. |
| `STC_BRP_BASE_URL` | STC's BRP API | Upstream API base URL. |
| `STC_BRP_APP_ID` | `383` | BRP app id. |

Logs are JSON events (`passage_attempt`, `open_door_timing`, `scheduled_session_reauthorization`). They carry door ids and outcomes, never logins, tokens or reader codes.

## Using it

1. Open the app and sign in with your STC login.
2. **Add a door**: give it a name and the reader's `major` and `minor`.
3. Optionally build a sequence from saved doors and choose a default for the start screen.
4. Tap a door or sequence to open it.
5. For a Shortcut or other automation, open **Devices**, create a device credential and copy it when it is shown (it is shown only once). A credential can be limited to chosen doors or sequences, expires after 1–90 days or never, and can be rotated or revoked.

Then one request opens a door:

```http
POST /api/open-door
Authorization: Bearer brpd_<id>.<secret>
Content-Type: application/json

{"doorName": "Main entrance"}
```

The full reference is in [docs/API.md](docs/API.md).

### Install on iPhone

Open the app in Safari and choose **Share → Add to Home Screen**. The Home Screen app keeps its own cookies, so sign in once more inside it.

## Security

- Login creates an `HttpOnly`, `Secure`, `SameSite=Strict` session. Every write needs a same-origin request and a session-bound CSRF token.
- Passwords, BRP tokens, customer ids and resolved reader codes are never returned to or stored in the browser.
- Device credentials are shown once; only a keyed hash is stored. BRP sessions, beacon values and opted-in renewal logins are AES-GCM encrypted.
- Refused logins are throttled: 5 per client and username and 20 per client in 15 minutes.
- The page runs under a strict CSP (`'self'` only, no inline code).
- Never commit `master.key`, databases, credentials or tokens. See [SECURITY.md](SECURITY.md).

## Development

```bash
gofmt -l .
go vet ./...
go test ./...
```

Tests run against an in-process fake BRP. **Never point tests or experiments at the real BRP API or real readers**: a passage request opens a physical door. To run locally, set `STC_BRP_BASE_URL` to a mock, `STC_KEY_FILE` and `STC_DB` to a temp directory, and `STC_ORIGIN=http://localhost:8796`.

## License and third parties

Copyright © 2026 LiquifyCD. Licensed under the custom [No-Comment Personal Use License](LICENSE). This project is source-available, not open source. Third-party components remain governed by their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
