# BRP Personal Client

Private, unofficial minimal door client for an authorized STC/BRP account.

The iPhone-ready PWA has two minimal tabs: **Open** and **Create**. New reader names default to **Main entrance**. A reader is configured once with its location (`major`) and door (`minor`) codes; those values are encrypted server-side and resolved through BRP immediately before opening.

## Install on iPhone

Open the site in Safari, then choose **Share → Add to Home Screen**. Launch the saved Home Screen app to use standalone mode without Safari's address/search bar. A normal Safari tab always keeps Safari's controls.

## Security

- Email, password, bearer token, refresh token, upstream cookies, customer ID, and numeric reader code are never stored, cached, logged, or returned.
- Stored `major` and `minor` values are encrypted and never returned to the browser.
- The card-reader ID is derived from BRP's passage-reader lookup and never accepted from the client.
- Cross-origin browser requests, oversized payloads, and rapid repeated attempts are rejected.
- `PASSAGE_ENABLED=false` is the committed safe default.

## API

See [`docs/API.md`](docs/API.md) for the base URL, `POST /api/open-door`, responses, reader configuration, and a safe example.

## Validation

```powershell
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

All automated tests use injected mock requests and must never reference or contact the real BRP/STC host or a real reader.

## Deployment

Set `SESSION_ENCRYPTION_KEY`, `PASSAGE_AUTHORIZATION_ID`, and `READER_CATALOG` as Worker secrets. Do not enable production door requests without verified written authorization from STC/BRP.

## License

Private project; no license granted.
