# Reader and door API

The browser authenticates with the normal login form and receives only an opaque `HttpOnly` session cookie and a CSRF token. BRP usernames, passwords, bearer tokens, refresh tokens, cookies, customer IDs, and numeric reader codes remain server-side.

## Configure readers

Reader codes are stored in the encrypted Cloudflare Worker secret `READER_CATALOG`. Add or replace the catalog with:

```powershell
npx wrangler secret put READER_CATALOG
```

Enter JSON in this format when prompted:

```json
{
  "main-entrance": { "label": "Main entrance", "code": 1234 },
  "side-door": { "label": "Side door", "code": 5678 }
}
```

Use only authorized codes. The keys and labels may be shown in the app; numeric codes are never returned by the API or stored in the repository. Deploy after updating the secret. Existing reader workspaces retain their configured code.

## Endpoints

### `GET /api/reader-options`

Returns the authenticated user's available server-configured reader aliases:

```json
{
  "options": [
    { "key": "main-entrance", "label": "Main entrance" }
  ]
}
```

### `POST /api/readers`

Creates a workspace using an alias from the server catalog:

```json
{
  "name": "Office",
  "readerKey": "main-entrance"
}
```

The server resolves `readerKey` to the numeric code. Arbitrary codes are rejected because `cardReader` is not accepted from the client.

### `POST /api/readers/{readerId}/door`

Requests a door action for the selected workspace:

```json
{
  "confirmed": true,
  "requestId": "11111111-1111-4111-8111-111111111111"
}
```

Required headers:

```http
Content-Type: application/json
X-CSRF-Token: <token from GET /api/session>
```

The server derives the customer ID, reader code, bearer token, and upstream cookie from the authenticated session and reader record. The request is protected by same-origin validation, CSRF, rate limiting, replay protection, and audit logging.

Possible statuses include `200` success, `400` invalid input, `401` expired session, `403` origin/CSRF failure, `404` unknown reader, `409` replay, `429` rate limit, and `503` disabled door actions.

## Safe development

Keep `PASSAGE_ENABLED=false`. `npm test` uses injected mock functions and never contacts BRP/STC or a real reader. Do not use the production endpoint for development or tests.
