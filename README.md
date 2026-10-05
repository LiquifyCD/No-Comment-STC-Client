# No-Comment STC Client

> [!WARNING]
> This is an unofficial third-party client. It is not affiliated with, endorsed by, or supported by STC, BRP Systems, or their affiliates. Use it only with your own account and readers/facilities you are explicitly authorized to operate. You assume all risk arising from use.

A minimal personal client for authenticated door operations, saved doors, sequences, and device credentials. This repository is **source-available, not open source**. Personal, noncommercial, unmodified use is permitted under the [No-Comment Personal Use License](LICENSE); modification, redistribution, sale, sublicensing, and commercial use are prohibited.

## What it does

STC gym doors are normally opened from the official app, which asks BRP (the membership system behind STC) to let the signed-in member through a specific door reader. This client makes the same request for you, so a door can be opened with one tap in a small web app or with one HTTP request from an automation such as an iPhone Shortcut.

- **Doors** — a saved door is a name plus the `major`/`minor` beacon values of its reader.
- **Sequences** — up to 8 saved doors opened in order, with a delay of up to 10 seconds between steps (for example the main entrance, then the inner door).
- **Device credentials** — a token for one automation, so the automation never holds your STC password.

## How it works

```text
Browser / Home Screen app ──cookie session──┐
                                            ├──► this server ──► BRP API ──► door reader
iPhone Shortcut ──device credential─────────┘
```

1. You sign in once with your own STC/BRP login. The server passes the password to BRP and keeps only the session BRP returns, encrypted with AES-GCM. The browser gets an `HttpOnly` cookie and never sees the BRP tokens.
2. When you open a door, the server takes the saved `major`/`minor` for that door, resolves the reader with BRP, and sends one passage request on your behalf. A sequence does this step by step and stops at the first failure.
3. An automation authenticates with a device credential (`brpd_<id>.<secret>`) instead of a login. The server stores only a keyed hash of it and uses your stored BRP session to make the request.
4. BRP sessions expire. Sign in again when a device reports that it needs reauthorization, or turn on **automatic renewal** in **Devices**: the login is then stored encrypted and the session is renewed every three days.

The server is a Cloudflare Worker (`worker/`) with a D1 database and KV sessions, serving the static web app in `web/`. Each account sees only its own doors, sequences and devices.

## Using it

1. Open the deployed site and sign in with your STC login.
2. **Add a door**: give it a name and the reader's `major` and `minor`.
3. Optionally **build a sequence** from saved doors and choose a default door or sequence for the start screen.
4. Tap the door or sequence to open it. Requests are limited to one per second per door.
5. For a Shortcut or other automation, open **Devices**, create a device credential and copy it when it is shown (it is shown only once). A credential can be limited to chosen doors or sequences, expires after 30, 60 or 90 days or never, and can be rotated or revoked.

Then one request opens a door:

```http
POST /api/open-door
Authorization: Bearer brpd_<id>.<secret>
Content-Type: application/json

{"doorName": "Main entrance"}
```

Use `{"sequenceName": "…"}` to run a sequence instead. Send exactly one of the two, using the names saved in the app. Success returns `{"ok":true,"message":"Request completed.","completedSteps":1,"timestamp":"…"}`; `401` means the credential is invalid or the session needs reauthorization, `403` that the target is not allowed for that device, `429` that you should wait a second, and `503` that door opening is switched off on the server. The full reference, including the Shortcut setup, is in [docs/API.md](docs/API.md).

> [!NOTE]
> The author's own deployment has since moved to a self-hosted Go port of this Worker that runs on a private network. It keeps the same web app, routes and error messages, so everything above applies to both; its source is not in this repository.

## Install on iPhone

Open the deployed site in Safari and choose **Share → Add to Home Screen**. Launch **No-Comment STC Client** from the Home Screen for standalone mode without Safari controls. A normal Safari tab or browser bookmark retains Safari's address bar.

The layout keeps a compact phone interface, switches to horizontal navigation on tablets, and uses the available desktop viewport up to a readable 1600px content width.

## Security

- Login creates an encrypted, `HttpOnly`, `Secure`, same-site server session.
- Passwords, bearer/refresh tokens, upstream cookies, customer IDs, and resolved reader codes are never returned to or persisted in the browser.
- Device credentials are displayed once. Only a keyed hash is stored; reusable upstream sessions remain AES-GCM encrypted server-side.
- All devices for one owner reference one canonical encrypted upstream session. Login or reauthorization replaces it for every device.
- Automatic renewal is opt-in. When enabled in **Devices**, the verified BRP username and password are stored together in an AES-GCM-encrypted server-side blob, never returned to the client, and deleted when the feature is disabled or credentials are rejected.
- Stored `major` and `minor` values are encrypted and never returned.
- Ownership is derived from the authenticated server session. Mutations require same-origin requests and a session-bound CSRF token.
- Door and sequence operations use atomic cooldown and replay protection.
- Never commit `.env`, `.dev.vars`, credentials, tokens, cookies, databases, certificates, or key files. Revoke exposed credentials immediately and follow [SECURITY.md](SECURITY.md).

## API

See [docs/API.md](docs/API.md) for the device API, iPhone Shortcut setup, session lifecycle, limits, and errors.

## Legacy production identifiers

The existing Worker name, D1 binding/database name, secrets, enabled settings, and production URL intentionally remain unchanged for compatibility:

```text
https://brp-personal-client.liquifycd.workers.dev
```

`PASSAGE_ENABLED` and all other existing enabled/disabled deployment values are preserved.

Existing native bundle identifiers, URL scheme, and secure-storage key names are also retained so installed apps and saved sessions keep working; they are compatibility identifiers, not the displayed product name.

## Local setup

```powershell
npm ci
npm test
npm run typecheck
npm run secret-scan
npx wrangler types --check
npx wrangler d1 migrations apply brp-personal-client --local
npx wrangler deploy --dry-run
```

Tests use mocked or local-only data and must never contact a real BRP/STC endpoint or reader.

## App icon

The native iPhone icon and PWA/Home Screen icons are generated from `assets/icon.png`. Replace them from a square source image with:

```powershell
python scripts/generate_icons.py "C:\path\to\icon.png"
```

The optional Python helper requires `requests` and explicit values supplied outside source control:

```powershell
$env:BRP_USERNAME="your-account"
$env:BRP_PASSWORD="your-password"
$env:BRP_AUTHORIZED_READER_ID="your-authorized-reader-id"
python scripts/brp_login.py
```

Only run it against your own authorized account and reader. Clear the environment variables afterward.

## Deployment

Set `SESSION_ENCRYPTION_KEY`, `PASSAGE_AUTHORIZATION_ID`, `READER_CATALOG`, and `OPEN_DOOR_API_KEY` as Worker secrets. Preserve the deployment's existing settings unless a separate change explicitly authorizes modifying them.

```powershell
npx wrangler d1 migrations apply brp-personal-client --remote
npx wrangler deploy
```

The Worker includes a bounded cron handler at `0 3,15 * * *` UTC. Native refresh remains disabled with `PROACTIVE_REFRESH_ENABLED=false` because its contract has not been verified. The independent `SCHEDULED_REAUTH_ENABLED=true` path instead uses the already verified full-login flow only for owners who explicitly enable automatic renewal in **Devices**. It renews at most every three days, processes at most 12 owners per run, never looks up readers or sends passage requests, and disables itself after rejected credentials. Transient failures retry at the next 12-hour cron run. Door requests still use only the cached session and never login on demand.

Test the disabled scheduled handler locally without contacting BRP:

```powershell
npx wrangler dev --test-scheduled
# In another terminal:
Invoke-WebRequest "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
```

## License and third parties

Copyright © 2026 LiquifyCD. Licensed under the custom [No-Comment Personal Use License](LICENSE). This project is source-available, not open source. Third-party components remain governed by their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
