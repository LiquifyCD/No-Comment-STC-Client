# No-Comment STC Client

> [!WARNING]
> This is an unofficial third-party client. It is not affiliated with, endorsed by, or supported by STC, BRP Systems, or their affiliates. Use it only with your own account and readers/facilities you are explicitly authorized to operate. You assume all risk arising from use.

A minimal personal client for authenticated door operations, saved doors, sequences, and device credentials. This repository is **source-available, not open source**. Personal, noncommercial, unmodified use is permitted under the [No-Comment Personal Use License](LICENSE); modification, redistribution, sale, sublicensing, and commercial use are prohibited.

## Install on iPhone

Open the deployed site in Safari and choose **Share → Add to Home Screen**. Launch **No-Comment STC Client** from the Home Screen for standalone mode without Safari controls. A normal Safari tab or browser bookmark retains Safari's address bar.

The layout keeps a compact phone interface, switches to horizontal navigation on tablets, and uses the available desktop viewport up to a readable 1600px content width.

## Security

- Login creates an encrypted, `HttpOnly`, `Secure`, same-site server session.
- Passwords, bearer/refresh tokens, upstream cookies, customer IDs, and resolved reader codes are never returned to or persisted in the browser.
- Device credentials are displayed once. Only a keyed hash is stored; reusable upstream sessions remain AES-GCM encrypted server-side.
- All devices for one owner reference one canonical encrypted upstream session. Login or reauthorization replaces it for every device without storing the BRP username or password.
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

The Worker includes a bounded cron handler at `0 3,15 * * *` UTC. `PROACTIVE_REFRESH_ENABLED` is deliberately `false`, and the refresh adapter performs no network request because no authorized capture has verified BRP's refresh method, path, headers, request body, cookie handling, response fields, token rotation, or failure semantics. Do not enable or deploy refresh calls until all of those details are verified. Until then, cached access tokens are used until expiry and an expired session returns a fast `401`; sign in and use **Reauthorize** to replace the shared owner session.

Test the disabled scheduled handler locally without contacting BRP:

```powershell
npx wrangler dev --test-scheduled
# In another terminal:
Invoke-WebRequest "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
```

## License and third parties

Copyright © 2026 LiquifyCD. Licensed under the custom [No-Comment Personal Use License](LICENSE). This project is source-available, not open source. Third-party components remain governed by their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
