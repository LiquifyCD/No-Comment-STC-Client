# Open-door API

```http
POST /api/open-door
Authorization: Bearer brpd_<id>.<secret>
Content-Type: application/json

{"doorName": "Gym"}
```

or `{"sequenceName": "Way in"}`. Names are the ones saved in the app, case-insensitive. Send exactly one of the two keys and nothing else.

| Status | Meaning |
| --- | --- |
| 200 | `{"ok":true,"message":"Request completed.","completedSteps":n,"timestamp":…}` |
| 400 | Malformed body (`Invalid request.`, `Provide exactly one doorName or sequenceName.`, `Invalid target name.`) |
| 401 | `Invalid or expired device credential.`, or `Device session needs reauthorization.`: sign in to the app again or turn on automatic renewal |
| 403 | `Target is not allowed for this device.` |
| 404 / 409 | Target not found / name is ambiguous |
| 429 | `Wait 1 second before retrying.` (one request per second per credential) |
| 502 / 401 | BRP refused the passage: `{"error":…,"failedStep":n,"completedSteps":n}` |
| 503 | `Door opening is disabled.` (`STC_PASSAGE_ENABLED`) |

Each door costs one BRP request. The reader code behind a door is looked up once and kept in memory, the BRP session is reused, and the connection to BRP is kept alive. Steps of a sequence with a 0-second delay between them are sent together; the first failing step is still the one reported, but a door after it in that group has been tried too, so give a step a delay if it must wait for the previous door.

## iPhone Shortcut

1. In the app, open **Devices**, create a credential and copy it.
2. In Shortcuts, add **Get Contents of URL** with the app's URL plus `/api/open-door`, method **POST**, header `Authorization` = `Bearer <credential>`, and a JSON body with `doorName` (or `sequenceName`).
3. Optionally add **Show Notification** with the result.

## Automatic renewal

With automatic renewal turned on in **Devices**, the login is stored encrypted and the BRP session is renewed every three days, so device credentials keep working without a visit to the app. A rejected login turns renewal off and deletes the stored login; an unreachable BRP is retried after 12 hours.

## Legacy form

Only when a legacy API key is configured: header `X-Api-Key: <key>`, body `{"email":…,"password":…,"doorName":…}`. It logs in to BRP on every call, so it is slower and puts the password in the automation. Prefer a device credential.
