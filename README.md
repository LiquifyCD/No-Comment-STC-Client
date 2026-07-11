# No-Comment STC Client

Private, unofficial Expo/React Native client for signing in to **your own** STC/BRP account and reading your own customer profile.

Includes a Cloudflare Worker web deployment. The browser never receives BRP access/refresh tokens: encrypted server-side sessions are referenced by an opaque `HttpOnly`, `Secure`, `SameSite=Strict` cookie.

## Safety and scope

- Read-only customer profile access only.
- No `passagetries`, card-reader, booking mutation, or physical-access calls.
- Passwords are sent only to the configured BRP login endpoint and never persisted.
- Access and refresh tokens use `expo-secure-store`; they are never logged.
- Cookies are handled by the platform HTTP session via `credentials: include`.
- This project is unofficial and requires authorization from the account owner and compliance with BRP/STC terms.

## Setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and verify the base URL/app ID.
3. Run `npm install`.
4. Run `npm start`, then open Android, iOS, or web. SecureStore is intended for native builds; do not use production tokens in an untrusted browser.

### Secure hosted web version

1. Authenticate Wrangler: `npx wrangler login`.
2. Create a 32-byte base64 key and store it only as the Worker secret `SESSION_ENCRYPTION_KEY`.
3. Deploy with `npm run web:deploy`. Wrangler automatically provisions the KV binding declared in `wrangler.jsonc`.

The web password is forwarded over HTTPS directly to BRP during login and is never stored or logged. BRP tokens and its affinity cookie are AES-GCM encrypted before being stored in KV. The frontend can only call the same-origin read-only profile route.

## Authentication flow

1. Load `/apps/{appId}` to establish the backend session/cookie.
2. POST credentials to `/auth/login`.
3. Store returned tokens in the device secure store.
4. GET only `/customers/{authenticatedCustomerId}`.
5. Attempt `/auth/refresh` near expiry. The exact refresh contract is not yet verified; unsupported refresh logs the user out safely.

## Configuration

Only `EXPO_PUBLIC_*` non-secret endpoint configuration belongs in `.env`. Never add usernames, passwords, cookies, or tokens to source control.

## Python login and profile script

[`scripts/brp_login.py`](scripts/brp_login.py) loads the BRP app configuration, authenticates against the BRP Systems API, keeps cookies in a `requests.Session`, and fetches the authenticated user's own customer profile. It prints profile field names but never prints access or refresh tokens.

Install its only external dependency:

```powershell
py -m pip install -r requirements.txt
```

Prefer temporary environment variables for non-interactive use. The following PowerShell prompts avoid placing credential values in shell history or the repository:

```powershell
$env:BRP_USERNAME = Read-Host "BRP username"
$securePassword = Read-Host "BRP password" -AsSecureString
$env:BRP_PASSWORD = [Net.NetworkCredential]::new("", $securePassword).Password
py scripts/brp_login.py
Remove-Item Env:BRP_USERNAME, Env:BRP_PASSWORD
$securePassword = $null
```

If the variables are absent, the script prompts for the username and reads the password without echoing it. Use it only with your own account or explicit authorization.

## Initial tasks

- [ ] Verify the refresh endpoint/body from an authorized capture and add contract tests.
- [ ] Add a cookie-jar adapter if native fetch persistence differs by platform.
- [ ] Add schema validation and a curated profile view instead of raw fields.
- [ ] Add mocked API tests and CI type-checking.
- [ ] Add biometric unlock as an optional local safeguard.
- [ ] Confirm logout/revocation endpoint, if officially supported.

## License

Private project; no license granted.
