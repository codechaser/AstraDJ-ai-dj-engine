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

Queue mutation commands are frozen for everyone when the Host has no connected socket in the Lounge. Reconnecting the Host clears that state. A vote that does not change a participant's existing vote returns current state without writing another event.

### Broadcast events

| Event | Payload | Contract |
|---|---|---|
| `lounge.queue.update` | `{ "queue": [{ "trackId": "t_2001", "position": 0 }], "reason": "add" }` | Broadcast to all Lounge sockets after a persisted queue command. Position `0` is Now Playing; following positions are Next Up. PRD reasons `vote`, `segue`, and `battle` remain reserved for those operations; this increment also uses `add` for explicit Host/Co-DJ queue additions. |
| `lounge.presence.update` | `{ "participantId": "<user id>", "action": "joined", "participantCount": 2, "hostDisconnected": false }` | Broadcast when a participant's first socket joins or last socket leaves. `participantCount` counts users, not tabs. |
| `lounge.sync.pong` | `{ "clientSentAt": 1792490000000, "serverReceivedAt": 1792490000001 }` | Returned to the requesting socket for latency measurement. |

`lounge.sync.ping` is accepted as a client command and its matching pong is emitted to that client. Queue update broadcasts currently include ordered track IDs; clients can resolve titles/artwork through the catalog endpoints.

### Error codes

`VALIDATION_ERROR` indicates malformed invite, track, vote, or timestamp input; `LOUNGE_NOT_FOUND` indicates an invalid/ended invite or missing room; `LOUNGE_FULL` indicates participant capacity; `LOUNGE_MEMBERSHIP_REQUIRED` indicates a protected command before join; `FORBIDDEN` indicates an insufficient role; `TRACK_NOT_FOUND` or `TRACK_NOT_QUEUED` indicates an invalid target; `TRACK_ALREADY_QUEUED` indicates a duplicate add; `HOST_DISCONNECTED` indicates frozen mutations; `AUTH_REQUIRED` and `INVALID_TOKEN` indicate failed authentication.

## Persistence and recovery

The in-memory queue holds ordered track IDs, current Now Playing ID, vote maps, and revision. MongoDB stores only compact append-only `QueueEvent` commands (`track.added` and `track.voted`) with a unique `(loungeId, seq)` index. Queue additions are persisted immediately. Vote events are batched per Lounge and flushed after 1 second or 20 events, whichever comes first; graceful shutdown flushes pending batches. A process crash can therefore lose the most recent unflushed vote batch, while all acknowledged additions remain durable. On first access after restart, the service loads the Lounge's persisted starting queue and replays durable events in sequence. Full queue snapshots are not written on each vote. A single API process is the supported runtime for this in-memory state; multiple replicas need coordinated state and a Socket.io adapter before deployment.

## Local verification

```powershell
cd server
npm test
```

The Socket.io integration suite creates an actual local Socket.io server and clients, but injects an in-memory repository. It is not a live MongoDB integration test. Configure `server/.env`, run `npm run seed`, start the API, and exercise the REST and socket contracts above to verify a configured MongoDB deployment. The current environment has no `server/.env`, so no live database check or seed was run.
