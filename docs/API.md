# Web API

Base URL:

```text
https://brp-personal-client.liquifycd.workers.dev
```

The web app uses same-origin session cookies. Mutating session routes require the `x-csrf-token` returned by `GET /api/session`. Responses never expose credentials, tokens, cookies, customer IDs, `major`, `minor`, or resolved reader codes.

## Login and session

```http
POST /api/login
Content-Type: application/json
```

```json
{"username":"user@example.com","password":"your-password"}
```

Successful login sets an encrypted `HttpOnly` session cookie. The browser then obtains session state with:

```http
GET /api/session
```

```json
{"authenticated":true,"expiresAt":"2026-07-12T12:00:00.000Z","csrfToken":"session-bound-value","passageEnabled":true}
```

## List doors

```http
GET /api/readers
```

Returns only owner-scoped display data required by the selector.

## Create a custom door

```http
POST /api/readers
x-csrf-token: session-bound-value
Content-Type: application/json
```

```json
{"name":"Front door","major":"1234","minor":"567890"}
```

Only the custom `major`/`minor` format is accepted. Client-supplied reader codes are rejected, and both custom values are validated and encrypted before storage.

## Open a door

```http
POST /api/readers/{readerId}/passage
x-csrf-token: session-bound-value
Content-Type: application/json
```

```json
{"confirmed":true,"requestId":"11111111-1111-4111-8111-111111111111"}
```

The Worker derives the customer and door configuration from the session and owner-scoped database row. Requests have a two-second atomic cooldown per owner and reader. A request during the cooldown returns:

```http
HTTP/1.1 429 Too Many Requests
```

```json
{"error":"Vänta 2 sekunder innan nästa försök."}
```

## Delete a door

```http
DELETE /api/readers/{readerId}
x-csrf-token: session-bound-value
Content-Type: application/json
```

```json
{"confirmed":true}
```

The server derives ownership from the session and deletes only a matching owner/reader row. Anonymous, cross-origin, invalid-CSRF, unconfirmed, other-owner, unknown, and repeated deletions are rejected. Success returns only:

```json
{"deleted":true}
```

## Logout

```http
POST /api/logout
x-csrf-token: session-bound-value
```

## Safe testing

Automated tests use mock functions, in-memory SQLite, or static contract checks. They never contact a real BRP/STC host or reader. Enabled settings are not changed by tests.
