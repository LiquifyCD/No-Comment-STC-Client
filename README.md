# No-Comment STC Client

Private, unofficial client for isolated reader workspaces for **your own** STC/BRP account. The hosted interface is an installable iPhone PWA backed by a Cloudflare Worker, encrypted KV sessions, and D1 persistence.

## Reader workspaces

- `/readers` lists the authenticated user's readers.
- `/readers/new` validates a unique name and opens the reader automatically.
- `/readers/:readerId` uses a permanent UUID and supports rename, confirmed deletion, and isolated audit history.
- Every query is scoped by a server-derived owner ID; names are never authorization identifiers.
- Existing users receive one `Standardläsare` during the one-time migration.

## Safety and scope

- The production `passagetries` POST is disabled by default and must remain disabled without written STC/BRP authorization.
- Customer ID always comes from the encrypted authenticated session; the browser cannot choose it.
- Card-reader ID is server-configured and cannot be supplied by the browser.
- Passwords are sent only to the configured BRP login endpoint and never persisted.
- Browser sessions use an opaque `HttpOnly`, `Secure`, `SameSite=Strict` cookie. BRP tokens and cookies are AES-GCM encrypted in KV.
- Passage attempts require same-origin and CSRF validation, explicit confirmation, a unique request ID, replay protection, rate limiting, and audit timestamps.
- This project is unofficial and requires authorization from the account owner and compliance with BRP/STC terms.

## Setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and verify the base URL/app ID.
3. Run `npm install`.
4. Run `npm start` for the native client or `npm run web:dev` for the Worker web interface.

### Secure hosted web version

1. Authenticate Wrangler: `npx wrangler login`.
2. Create a 32-byte base64 key and store it only as the Worker secret `SESSION_ENCRYPTION_KEY`.
3. Create the D1 database, apply `migrations/0001_readers.sql`, then deploy with `npm run web:deploy`.

Install the deployed site using Safari's **Add to Home Screen**. The standalone app handles iPhone safe areas and never caches `/api/*` responses.

The password is forwarded over HTTPS directly to BRP during login and is never stored or logged. The frontend receives session status and a CSRF token, never BRP credentials.

## Authentication and passage flow

1. Load `/apps/{appId}` to establish the backend affinity cookie.
2. POST credentials to `/auth/login`.
3. Encrypt BRP tokens, cookie, customer ID, and CSRF state in the server-side session.
4. Derive the customer ID from that session and use only the server-configured reader.
5. Keep the production passage POST disabled unless the authorization gate below is satisfied.

## Passage authorization gate

The committed and deployed configuration uses `PASSAGE_ENABLED=false` and an `UNAUTHORIZED` placeholder secret. Do not change it for production without written authorization. After authorization, record its reference as a Worker secret named `PASSAGE_AUTHORIZATION_ID` in the form `APPROVED-<reference>`, confirm the server-side `PASSAGE_CARD_READER` allowlist, and only then set `PASSAGE_ENABLED=true`.

Run the mocked policy tests without contacting BRP:

```powershell
npm test
npm run typecheck
```

## Python login and profile script

[`scripts/brp_login.py`](scripts/brp_login.py) loads the BRP app configuration, authenticates against the BRP Systems API, keeps cookies in a `requests.Session`, and fetches the authenticated user's own customer profile. It prints profile field names but never prints access or refresh tokens.

```powershell
py -m pip install -r requirements.txt
$env:BRP_USERNAME = Read-Host "BRP username"
$securePassword = Read-Host "BRP password" -AsSecureString
$env:BRP_PASSWORD = [Net.NetworkCredential]::new("", $securePassword).Password
py scripts/brp_login.py
Remove-Item Env:BRP_USERNAME, Env:BRP_PASSWORD
$securePassword = $null
```

Use the script only with your own account or explicit authorization.

## License

Private project; no license granted.
