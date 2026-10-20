# AstraDJ API reference

The base URL defaults to `http://localhost:4000`. REST endpoints are rooted at `/api/v1`; the Socket.io gateway shares this server. JSON validation errors use `{ "error": { "code", "message", "details" } }`.

## REST endpoints

| Method and path | Access | Purpose |
|---|---|---|
| `GET /health` | Public | API and Mongo connection state |
| `GET /api/v1/health` | Public | Same health response |
| `POST /api/v1/auth/register` | Public | Register a Listener; submitted roles are ignored |
| `POST /api/v1/auth/login` | Public | Login; returns short-lived access JWT and refresh cookie |
| `POST /api/v1/auth/refresh` | Refresh cookie | Rotate refresh token and issue an access JWT |
| `POST /api/v1/auth/logout` | Refresh cookie | Revoke the presented refresh token |
| `GET /api/v1/auth/me` | Bearer JWT | Current user profile and server-side role |
| `GET /api/v1/tracks?q=&limit=&skip=` | Public | Validated track catalog page |
| `GET /api/v1/tracks/:trackId/acoustic-profile` | Public | Acoustic vector and metadata timeline |
| `POST /api/v1/tracks` | Admin | Add a validated acoustic profile |
| `POST /api/v1/lounges` | Host | Create a Lounge and return its invite code |
| `POST /api/v1/lounges/:id/ai/segue` | Authenticated Lounge member | Select an acoustically compatible segue and return a grounded transition |

### AI DJ segue

`POST /api/v1/lounges/:id/ai/segue` requires a Bearer access token and membership in the active Lounge. It verifies that the body `currentTrackId` is the Lounge's current track and that `currentTs` does not exceed its duration.

Required request fields follow PRD §7.3.3; `recentTrackIds` is an optional addition because the current Lounge model has no playback-history field. The caller supplies most-recent-first track IDs when available:

```json
{
  "currentTrackId": "t_2001",
  "currentTs": 198,
  "candidateTrackIds": ["t_2002", "t_2003", "t_2004"],
  "currentSentimentScore": 0.72,
  "recentTrackIds": ["t_2004", "t_2003"]
}
```

The service rejects invalid acoustic profiles, excludes unknown/incompatible candidates, and returns the best eligible track. If none qualifies it returns HTTP 200 with `selectedTrackId: null`, empty `sourceEvents`, and `reason: "NO_COMPATIBLE_CANDIDATE"`; it never forces a clash into the queue. It does not mutate the shared queue.

```json
{
  "selectedTrackId": "t_2002",
  "matchReason": {
    "bpmDeltaPct": 3.23,
    "bpmRelation": "direct",
    "camelotRelation": "adjacent",
    "energyFit": 0.932,
    "harmonicCloseness": 0.8,
    "targetEnergy": 0.868,
    "recencyScore": 1,
    "score": 0.8796,
    "selectionReason": "adjacent Camelot match; direct tempo at 3.23% delta; ..."
  },
  "transitionScript": "AstraDJ deterministic fallback: from … Track metadata: …",
  "sourceEvents": ["t_2002#timeline[0]"],
  "generatedAt": "2026-10-20T00:00:00.000Z",
  "provider": "deterministic_fallback"
}
```

Eligibility requires BPM within the Lounge's configured tolerance (maximum 8%) against direct, half-time, or double-time BPM, and Camelot same-key, same-letter adjacent number with 12↔1 wrap, or same-number opposite-letter relation. Harmonic closeness weights are same `1.0`, adjacent `0.8`, relative `0.6`. Energy target is `clamp(currentEnergy + (sentiment - 0.5) × 0.4)`; `energyFit = 1 - abs(candidateEnergy - targetEnergy)`. Recency is `0` when a candidate occurs in the first five supplied `recentTrackIds`, otherwise `1`. Total is `0.50 × harmonic + 0.30 × energy fit + 0.20 × recency`; input candidate order breaks exact score ties. These deterministic scoring details fill gaps the PRD leaves unspecified.

`sourceEvents` uses stable pointers in the form `trackId#timeline[index]` into the Track metadata timeline. The current built-in provider is `deterministic_fallback`: it uses only the selected/current title, artist, and the selected track's first non-empty metadata timeline entry. No external LLM provider is configured or called. The segue service accepts a provider object through dependency injection for future provider integration.

## Socket.io connection and event contract

Connect with the same access JWT as REST authentication:

```js
const socket = io('http://localhost:4000', {
  auth: { token: accessToken },
});
```

The server validates the JWT at handshake and reloads the account and role from MongoDB for every room-sensitive command. The client cannot select a Socket.io room by `loungeId`; it must join with a valid invite code. Each socket can join one Lounge. The configured capacity is enforced against unique connected users plus in-flight join reservations, so multiple tabs for one user count once and users who leave free a slot. `participantIds` on the Lounge remains the set of users who have joined at least once. Capacity coordination is process-local; multi-replica deployment is not supported yet.

Every server event follows the PRD envelope:

```json
{
  "event": "lounge.queue.update",
  "loungeId": "lg_123456789abc",
  "payload": {},
  "ts": 1792490000000
}
```

### Client commands and acknowledgements

Each command takes a payload and a Socket.io acknowledgement callback. Success has `{ "ok": true, ... }`; failures have `{ "ok": false, "error": { "code", "message" } }`.

| Command | Payload | Authorization and result |
|---|---|---|
| `lounge.join` | `{ "inviteCode": "SP-9X2L" }` | Any authenticated user with a valid active invite may join if capacity permits. Ack includes `loungeId` and full `state`: `revision`, `nowPlaying`, ordered `nextUp` with vote totals, `presence`, `hostDisconnected`, and `syncedAt`. |
| `lounge.queue.add` | `{ "trackId": "t_2002" }` | Joined Host or Co-DJ only; track must exist and not already be queued. Ack includes authoritative state. |
| `lounge.queue.vote` | `{ "trackId": "t_2002", "value": 1 }` | Any joined participant may vote on a queued track. Values are `1`, `-1`, or `0` (remove the participant's vote). Order is computed server-side by vote total, with stable insertion order for ties. Ack includes authoritative state. |
| `lounge.sync.request` | `{}` | Joined participant only; ack includes a fresh complete state snapshot. Use after reconnect/resume. |
| `lounge.sync.ping` | `{ "clientSentAt": 1792490000000 }` | Joined participant only; ack includes the pong values and the sender receives `lounge.sync.pong`. |
| `lounge.chat.message` | `{ "body": "This set is amazing!" }` | Authenticated Lounge member only. Server sanitizes text, assigns its own sentiment bucket, and acks with the accepted message and current sentiment snapshot. |
| `lounge.chat.history` | `{ "limit": 50 }` (limit optional) | Authenticated Lounge member only; returns the latest 1–100 persisted plus pending messages in chronological order. |

Queue mutation commands are frozen for everyone when the Host has no connected socket in the Lounge. Reconnecting the Host clears that state. A vote that does not change a participant's existing vote returns current state without writing another event.

### Broadcast events

| Event | Payload | Contract |
|---|---|---|
| `lounge.queue.update` | `{ "queue": [{ "trackId": "t_2001", "position": 0 }], "reason": "add" }` | Broadcast to all Lounge sockets after a persisted queue command. Position `0` is Now Playing; following positions are Next Up. PRD reasons `vote`, `segue`, and `battle` remain reserved for those operations; this increment also uses `add` for explicit Host/Co-DJ queue additions. |
| `lounge.presence.update` | `{ "participantId": "<user id>", "action": "joined", "participantCount": 2, "hostDisconnected": false }` | Broadcast when a participant's first socket joins or last socket leaves. `participantCount` counts users, not tabs. |
| `lounge.sync.pong` | `{ "clientSentAt": 1792490000000, "serverReceivedAt": 1792490000001 }` | Returned to the requesting socket for latency measurement. |
| `lounge.chat.message` | `{ "messageId": "<uuid>", "userId": "<user id>", "body": "This set is amazing!", "sentimentBucket": "positive", "tsSeconds": 1792490000 }` | Emitted only to sockets in the authorized Lounge room after acceptance. `userId` and sentiment are server-derived; client-supplied identity or bucket fields are rejected. `tsSeconds` is server Unix time. |
| `lounge.sentiment.score` | `{ "rollingScore": 1, "windowSeconds": 300, "sampleSize": 1 }` | Emitted to the same Lounge after each accepted message. Score is 0–1, with 0.5 neutral; sample size counts messages in the rolling window. |

`lounge.sync.ping` is accepted as a client command and its matching pong is emitted to that client. Queue update broadcasts currently include ordered track IDs; clients can resolve titles/artwork through the catalog endpoints.

### Lounge chat and sentiment

Chat accepts only `{ body }`. The server NFKC-normalizes text, removes control characters and HTML-like tags, trims whitespace, and accepts 1–500 Unicode code points after sanitization. Each user is limited to five accepted messages per Lounge per rolling 10 seconds. Authentication, joined socket state, persisted `participantIds` membership, and current user role are checked server-side on every command. History reads use the same authorization and cannot select a Lounge ID from the client.

Messages are buffered per Lounge and persisted as `ChatMessage` documents in batches of 20 or after one second. Mongo writes use message-ID upserts so a retry does not duplicate a message; graceful shutdown flushes pending chat batches. `lounge.chat.history` returns at most 100 recent messages, including messages in the write buffer, for reconnect/context restoration. Stored records include `msgType: "chat"`, the bucket, and its 0–1 numeric score.

The PRD does not specify a classifier, score scale/formula, or aggregation duration. This implementation uses a deliberately small deterministic English keyword lexicon (not ML): buckets are `positive`, `neutral`, or `negative`; bucket values map to 1, 0.5, and 0 respectively; room score is their arithmetic mean over the previous 300 seconds. This behavior is testable but sentiment accuracy is **not evaluated** and the PRD's 85% KPI is not claimed. Empty windows report neutral `0.5` with `sampleSize: 0`. The segue service trusts room sentiment only after at least three recent messages; with fewer messages it supplies neutral `0.5` to the unchanged acoustic matcher, preserving the current track's energy target. The existing `currentSentimentScore` request field remains required for request compatibility but is not authoritative.

Chat buffers, sentiment windows, and rate-limit state are process-local. A single API process is supported; multi-replica synchronization and distributed rate limiting are not implemented. Typing indicators and emoji reactions named in the broader PRD remain unimplemented because their event payload contracts are unspecified.

### Error codes

`VALIDATION_ERROR` indicates malformed invite, track, vote, timestamp, or chat input; `CHAT_RATE_LIMITED` indicates more than five chat messages in ten seconds; `LOUNGE_NOT_FOUND` indicates an invalid/ended invite or missing room; `LOUNGE_FULL` indicates participant capacity; `LOUNGE_MEMBERSHIP_REQUIRED` indicates a protected command before join; `FORBIDDEN` indicates an insufficient role; `TRACK_NOT_FOUND` or `TRACK_NOT_QUEUED` indicates an invalid target; `TRACK_ALREADY_QUEUED` indicates a duplicate add; `HOST_DISCONNECTED` indicates frozen mutations; `AUTH_REQUIRED` and `INVALID_TOKEN` indicate failed authentication.

## Persistence and recovery

The in-memory queue holds ordered track IDs, current Now Playing ID, vote maps, and revision. MongoDB stores only compact append-only `QueueEvent` commands (`track.added` and `track.voted`) with a unique `(loungeId, seq)` index. Queue additions are persisted immediately. Vote events are batched per Lounge and flushed after 1 second or 20 events, whichever comes first; graceful shutdown flushes pending batches. A process crash can therefore lose the most recent unflushed vote batch, while all acknowledged additions remain durable. On first access after restart, the service loads the Lounge's persisted starting queue and replays durable events in sequence. Full queue snapshots are not written on each vote. A single API process is the supported runtime for this in-memory state; multiple replicas need coordinated state and a Socket.io adapter before deployment.

## Local verification

```powershell
cd server
npm test
```

The Socket.io suite creates an actual local Socket.io server and clients but injects an in-memory repository. Optional `tests/segue.mongo.integration.test.js` and `tests/chat.mongo.integration.test.js` suites use `MONGODB_TEST_URI`, create unique temporary databases, exercise real Mongoose persistence, and drop only those test databases in cleanup. Do not point them at production data. For a local MongoDB without credentials, set `MONGODB_TEST_URI=mongodb://127.0.0.1:27017` in the shell before running the full suite. The current `server/.env` is absent, so the API's normal runtime connection and production seed have not been configured or run.
