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

## Local setup

```powershell
npm ci
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

Tests use mocked or local-only data and must never contact a real BRP/STC endpoint or reader.

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

`BRP_REFRESH_PATH` remains intentionally unset until the upstream refresh request is verified. Access tokens are reused until expiry; reauthorize the device after signing in again if refresh is unavailable.

## License and third parties

Copyright © 2026 LiquifyCD. Licensed under the custom [No-Comment Personal Use License](LICENSE). It is restrictive and has not been reviewed for your jurisdiction; obtain independent legal review before relying on it. Third-party components remain governed by their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
