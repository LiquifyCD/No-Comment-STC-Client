# Passage-reader lookup API

Base URL:

```text
https://brp-personal-client.liquifycd.workers.dev
```

## Create a reader

```http
POST /api/configured-readers
Content-Type: application/json
```

```json
{
  "name": "Front door",
  "major": "1234",
  "minor": "567890",
  "email": "user@example.com",
  "password": "your-password"
}
```

The credentials authenticate ownership and are discarded immediately. `major` and `minor` are encrypted before being stored. The API returns only the permanent reader UUID and display name:

```json
{
  "reader": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Front door"
  }
}
```

`GET /api/configured-readers` returns only configured reader UUIDs and names for the selector. It never returns `major`, `minor`, or a resolved card-reader ID.

## Open a door

```http
POST /api/open-door
Content-Type: application/json
```

```json
{
  "email": "user@example.com",
  "password": "your-password",
  "reader": "11111111-1111-4111-8111-111111111111"
}
```

The Worker:

1. Authenticates through BRP in memory.
2. Verifies that the reader UUID belongs to the authenticated customer.
3. Decrypts its stored `major` and `minor`.
4. Calls `GET /passagereaders?major={major}&minor={minor}`.
5. Validates the lookup response and uses its server-derived `id` for the passage request.
6. Discards credentials, tokens, cookies, customer ID, lookup values, and the resolved reader ID.

Success:

```json
{ "ok": true }
```

Error:

```json
{ "error": "Reader not found." }
```

The endpoint rejects client-supplied `major`, `minor`, `cardReader`, customer IDs, tokens, and cookies. Browser calls must be same-origin; direct API clients omit the `Origin` header.

## Safe testing

All tests inject `mock.invalid` responses for configuration, login, passage-reader lookup, and passage creation. Tests never reference or contact the real BRP/STC hostname or a real reader. Keep `PASSAGE_ENABLED=false` during development and testing.
