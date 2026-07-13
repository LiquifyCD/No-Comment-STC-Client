# Web API

Base URL:

```text
https://brp-personal-client.liquifycd.workers.dev
```

The web app uses same-origin session cookies. Mutating session routes require the `x-csrf-token` returned by `GET /api/session`. Responses never expose credentials, tokens, cookies, customer IDs, `major`, `minor`, or resolved reader codes.

## One-request API

`POST /api/open-door` is for an authorized personal client on another device. It requires HTTPS and the independent `OPEN_DOOR_API_KEY` Worker secret in `x-api-key`.

```http
POST /api/open-door
x-api-key: your-separate-api-key
Content-Type: application/json

{"email":"user@example.com","password":"your-password","doorName":"Main entrance"}
```

Use `sequenceName` instead of `doorName` to run a saved sequence. Exactly one target name is required:

```json
{"email":"user@example.com","password":"your-password","sequenceName":"Main then sluss"}
```

The Worker authenticates directly with BRP, derives the customer identity from that response, and resolves the normalized target name only against doors or sequences saved for that owner. Unknown, ambiguous, or unauthorized names are rejected. Credentials, cookies, and tokens exist only during the Worker request and are never stored or returned. Success contains only:

```json
{"ok":true,"message":"Request completed.","completedSteps":2,"timestamp":"2026-07-13T12:00:00.000Z"}
```

Configure the API key interactively and never commit it:

```powershell
npx wrangler secret put OPEN_DOOR_API_KEY
```

PowerShell example. The password is requested without echo and is not placed in shell history:

```powershell
$base = "https://brp-personal-client.liquifycd.workers.dev"
$email = Read-Host "BRP email"
$target = Read-Host "Saved door or sequence name"
$targetType = Read-Host "Type door or sequence"
$securePassword = Read-Host "BRP password" -AsSecureString
$credential = [pscredential]::new($email, $securePassword)
$bodyData = @{ email = $email; password = $credential.GetNetworkCredential().Password }
if ($targetType -eq "sequence") { $bodyData.sequenceName = $target } else { $bodyData.doorName = $target }
$body = $bodyData | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/api/open-door" -Headers @{ "x-api-key" = $env:OPEN_DOOR_API_KEY } -ContentType "application/json" -Body $body
$body = $null; $bodyData = $null; $credential = $null
```

Load `OPEN_DOOR_API_KEY` through the device's secure secret storage before running the example. Do not type passwords or API keys directly into commands because arguments and shell history may be readable by other software.

Minimal curl example for systems where values are supplied by secure environment/secret storage:

```bash
jq -n --arg email "$BRP_EMAIL" --arg password "$BRP_PASSWORD" --arg target "$BRP_TARGET_NAME" --arg type "$BRP_TARGET_TYPE" \
  '{email:$email,password:$password} + (if $type == "sequence" then {sequenceName:$target} else {doorName:$target} end)' |
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    -H "x-api-key: $OPEN_DOOR_API_KEY" \
    --data-binary @- \
    "https://brp-personal-client.liquifycd.workers.dev/api/open-door"
```

The endpoint applies an IP pre-authentication limit and the same atomic one-second owner/door cooldown as the web app. Requests with a foreign browser `Origin`, invalid API key, invalid credentials, or an unowned target are rejected. A sequence stops at its first failed step and returns only `failedStep`, `completedSteps`, and a safe error.

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

The Worker derives the customer and door configuration from the session and owner-scoped database row. Requests have a one-second atomic cooldown per owner and reader. A request during the cooldown returns:

```http
HTTP/1.1 429 Too Many Requests
```

```json
{"error":"Vänta 1 sekund innan nästa försök."}
```

## Sequences

List owner-scoped sequences:

```http
GET /api/sequences
```

Create or replace steps using saved door names only. Limits are 8 steps, 10 seconds per delay, and 30 seconds total delay. The final delay is always zero.

```http
POST /api/sequences
x-csrf-token: session-bound-value
Content-Type: application/json
```

```json
{"name":"Main then sluss","steps":[{"doorName":"Main entrance","delaySeconds":3},{"doorName":"Sluss","delaySeconds":0}]}
```

Use `PATCH /api/sequences/{sequenceId}` with the same body to rename, edit, or reorder it. Use `DELETE /api/sequences/{sequenceId}` with `{"confirmed":true}` to delete it.

Run a saved sequence:

```http
POST /api/sequences/{sequenceId}/run
x-csrf-token: session-bound-value
Content-Type: application/json
```

```json
{"confirmed":true,"requestId":"11111111-1111-4111-8111-111111111111"}
```

Steps run sequentially and stop on the first failure. The response exposes only completion counts, the failed step when relevant, a timestamp, and a safe message.

Common statuses are `400` invalid input, `401` unauthenticated/invalid credentials, `403` origin/CSRF failure, `404` unknown owner-scoped target, `409` duplicate/ambiguous/replayed request, `429` cooldown, `502` BRP failure, and `503` disabled passage access.

## Default selection

`GET /api/default` returns the valid owner-scoped default. If it was deleted or is unavailable, the server falls back to the first valid saved item.

Set a default by saved name:

```http
PUT /api/default
x-csrf-token: session-bound-value
Content-Type: application/json
```

```json
{"type":"sequence","name":"Main then sluss"}
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
