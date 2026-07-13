# No-Comment STC Client

Private, unofficial minimal door client for an authorized STC/BRP account.

The PWA has **Open**, **Create**, and **Sequences** tabs. Create accepts only a custom name, `major` location code, and `minor` door code. Sequences run saved doors in order with controlled delays. Doors and sequences can be removed after explicit confirmation, and either type can be selected as the owner-scoped default.

## Install on iPhone

Open the site in Safari and choose **Share → Add to Home Screen**. Launch **No-Comment STC Client** from the Home Screen for standalone mode without Safari controls. A normal Safari tab or bookmark retains Safari’s address bar.

The adaptive layout keeps the existing compact phone design, uses horizontal navigation on tablets, and fills desktop viewports without outer borders. Desktop content remains readable with a 1600px maximum content width.

## Security

- Login establishes an encrypted, `HttpOnly`, `Secure`, same-site server session.
- Passwords, bearer/refresh tokens, upstream cookies, customer IDs, and resolved reader codes are never returned or persisted in the browser.
- Stored `major` and `minor` values are encrypted and never returned.
- Creation, opening, and deletion derive ownership from the authenticated server session.
- Mutations require same-origin requests and a session-bound CSRF token.
- Door and sequence steps have an atomic, server-side one-second cooldown per authenticated owner and reader, plus replay protection.
- Sequences accept only saved door names. Customer IDs, reader IDs/codes, `major`, `minor`, tokens, and cookies are resolved or retained server-side.
- Enabled and deployment settings remain deployment-controlled. This change did not alter `PASSAGE_ENABLED` or any other existing enabled/disabled value.

## API

See [`docs/API.md`](docs/API.md) for doors, sequences, defaults, limits, errors, and the API-key-protected one-request `POST /api/open-door` integration.

## Branding

The source logo is [`web/icon.svg`](web/icon.svg). Rebuild the opaque Apple, regular, and maskable PNG icons with:

```powershell
python scripts/generate_icons.py
```

## Validation

```powershell
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

Tests use mocked or local-only data and never contact a real BRP/STC endpoint or reader.

## Deployment

Set `SESSION_ENCRYPTION_KEY`, `PASSAGE_AUTHORIZATION_ID`, `READER_CATALOG`, and `OPEN_DOOR_API_KEY` as Worker secrets. Preserve the deployment’s existing enabled settings unless a separate change explicitly authorizes modifying them.

```powershell
npx wrangler d1 migrations apply brp-personal-client --remote
npx wrangler deploy
```

## License

Private project; no license granted.
