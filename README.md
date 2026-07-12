# BRP Personal Client

Private, unofficial minimal door client for an authorized STC/BRP account.

The PWA has two tabs: **Open** and **Create**. Create accepts only a custom name, `major` location code, and `minor` door code. Saved doors can be removed from Open after explicit confirmation.

## Install on iPhone

Open the site in Safari and choose **Share → Add to Home Screen**. Launch **BRP Open** from the Home Screen for standalone mode without Safari controls. A normal Safari tab or bookmark retains Safari’s address bar.

The layout prioritizes iPhone 13 at 390×844 CSS pixels and remains centered with bounded controls on 2560×1440 displays. Touch controls are at least 44 points and respect iPhone safe areas.

## Security

- Login establishes an encrypted, `HttpOnly`, `Secure`, same-site server session.
- Passwords, bearer/refresh tokens, upstream cookies, customer IDs, and resolved reader codes are never returned or persisted in the browser.
- Stored `major` and `minor` values are encrypted and never returned.
- Creation, opening, and deletion derive ownership from the authenticated server session.
- Mutations require same-origin requests and a session-bound CSRF token.
- Door opening has an atomic, server-side two-second cooldown per authenticated owner and reader, plus replay protection.
- Enabled and deployment settings remain deployment-controlled. This change did not alter `PASSAGE_ENABLED` or any other existing enabled/disabled value.

## API

See [`docs/API.md`](docs/API.md) for the session, reader, passage, and deletion contracts used by the web app.

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

Set `SESSION_ENCRYPTION_KEY`, `PASSAGE_AUTHORIZATION_ID`, and `READER_CATALOG` as Worker secrets. Preserve the deployment’s existing enabled settings unless a separate change explicitly authorizes modifying them.

## License

Private project; no license granted.
