# BRP Personal Client

Private, unofficial Expo/React Native client for signing in to **your own** STC/BRP account and reading your own customer profile.

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

## Authentication flow

1. Load `/apps/{appId}` to establish the backend session/cookie.
2. POST credentials to `/auth/login`.
3. Store returned tokens in the device secure store.
4. GET only `/customers/{authenticatedCustomerId}`.
5. Attempt `/auth/refresh` near expiry. The exact refresh contract is not yet verified; unsupported refresh logs the user out safely.

## Configuration

Only `EXPO_PUBLIC_*` non-secret endpoint configuration belongs in `.env`. Never add usernames, passwords, cookies, or tokens to source control.

## Initial tasks

- [ ] Verify the refresh endpoint/body from an authorized capture and add contract tests.
- [ ] Add a cookie-jar adapter if native fetch persistence differs by platform.
- [ ] Add schema validation and a curated profile view instead of raw fields.
- [ ] Add mocked API tests and CI type-checking.
- [ ] Add biometric unlock as an optional local safeguard.
- [ ] Confirm logout/revocation endpoint, if officially supported.

## License

Private project; no license granted.
