# Open door API

Base URL:

```text
https://brp-personal-client.liquifycd.workers.dev
```

Endpoint:

```http
POST /api/open-door
Content-Type: application/json
```

Body:

```json
{
  "email": "user@example.com",
  "password": "your-password",
  "reader": "configured-reader-alias"
}
```

The Worker validates the reader alias against the encrypted `READER_CATALOG`, performs the BRP login in memory, and immediately sends the door request. It never stores, caches, returns, or logs the email, password, bearer token, refresh token, upstream cookie, customer ID, or numeric reader code.

Successful response:

```json
{ "ok": true }
```

Error response:

```json
{ "error": "Invalid credentials." }
```

Possible statuses include `200`, `400`, `401`, `403`, `413`, `429`, `502`, and `503`.

Example:

```js
const response = await fetch(
  "https://brp-personal-client.liquifycd.workers.dev/api/open-door",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "user@example.com",
      password: "your-password",
      reader: "main-entrance"
    })
  }
);

console.log(response.status, await response.json());
```

For browser requests, the Worker accepts the deployed site's own origin. Direct API clients should omit the `Origin` header. Cross-origin browser requests are rejected.

## Reader aliases

Reader codes remain in the Cloudflare secret `READER_CATALOG`. Configure it with:

```powershell
npx wrangler secret put READER_CATALOG
```

Example secret value:

```json
{
  "main-entrance": { "label": "Main entrance", "code": 1234 }
}
```

Only the alias and label are exposed through `GET /api/reader-options`; the numeric code stays server-side.

## Safe testing

Tests inject a mock fetch function and use only `mock.invalid`. They never reference or contact the real BRP/STC host or a real reader. Keep `PASSAGE_ENABLED=false` during development and testing.
