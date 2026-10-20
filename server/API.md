# AstraDJ API reference

The base URL defaults to `http://localhost:4000`. REST endpoints are rooted at `/api/v1`; the Socket.io gateway shares this server. JSON validation errors use `{ "error": { "code", "message", "details" } }`.

The Vite client defaults to same-origin `/api/v1` and Socket.io. Set `VITE_DEV_API_TARGET` to change the Vite development proxy target, or set `VITE_API_BASE_URL` at build time for a deployed API origin/base path. Set server `CLIENT_ORIGIN` to the exact frontend origin to enable credentialed CORS. Refresh cookies use `SameSite=Strict`; deploy the client and API same-site over HTTPS or behind a same-origin reverse proxy.

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
| `POST /api/v1/lounges/:id/ai/ask` | Authenticated active Lounge member | Answer a question from the current track's stored metadata with source references |
| `POST /api/v1/interactions` | Bearer JWT | Record the authenticated user's self-reported listen/like interaction; optional live Lounge co-listening context is checked server-side |
| `GET /api/v1/recommendations?limit=10` | Bearer JWT | Return a private ranked recommendation rail for the authenticated user |
| `GET /api/v1/dashboard/playback-history?limit=20` | Bearer JWT | Return the caller's own explicitly self-reported Interaction history |
| `GET /api/v1/dashboard/lounges/:id/analytics` | Bearer JWT + Lounge membership | Aggregate available persisted Lounge metrics; unavailable metrics are returned as `null` |

### Dashboard history and Lounge analytics

Playback history reads existing `Interaction` documents and is scoped to the authenticated user. Existing rows have `source: "self_reported"`; they are not evidence that audio played. The connected AstraDJ player can submit one completion interaction only from the browser audio element's actual `ended` event, for a catalog track with an `audioAssetUrl` and a measured duration within one second of catalog metadata. This is app-observed, client-reported playback, not externally verified listening. The current seed tracks have no playable `audioAssetUrl`, so the player currently cannot create a completion record. Track selection, queue actions, likes by themselves, and recommendations do not create playback interactions; no start/progress events are submitted. `limit` is optional (default 20, maximum 100); an empty history returns `{ "items": [] }`.

Lounge analytics are restricted to the Lounge host or a persisted participant (including ended rooms). `durationSeconds` is currently `null`: the Lounge model does not persist when a session actually started, and `createdAt` may include scheduled/setup time. `queueEventCount` counts stored QueueEvent rows, `soundclashBattles` counts persisted `soundclash.opened` rows, and `chatMessageCount` plus `sentimentTimeline` come from persisted ChatMessage records. Sentiment entries reproduce stored message-level heuristic scores and timestamps; they are not an independently verified mood measure. `peakConcurrentParticipants` and `aiDjQuestionCount` are returned as `null` with explanations because presence peaks and question events are not persisted today. No metric is inferred from current socket counts or UI mock data.

### Recommendations and listening interactions

The PRD requires a hybrid acoustic-similarity and collaborative-filtering recommendation rail but leaves route names, score formulas, and thresholds open. The selected minimal REST contract is `POST /api/v1/interactions` plus `GET /api/v1/recommendations`. Both require a valid JWT. The interaction writer derives `userId` from that token, rejects caller-supplied identity and unknown fields, and validates that `playedSeconds` does not exceed the catalog duration; `completed: true` requires the full reported duration.

```json
POST /api/v1/interactions
{
  "trackId": "t_2001",
  "playedSeconds": 224,
  "completed": true,
  "liked": true,
  "loungeId": "lg_123456789abc"
}
```

`loungeId` is optional. When present, the server verifies that the requester is a persisted Lounge participant, the Lounge is live, and the requested track is its current track. It derives `coListenedWith` links from other user-reported records for that same track and Lounge in a 10-minute server-time window. The client cannot submit co-listener IDs. This is a co-listening proxy, not playback telemetry: the server does not independently verify reported duration, completion, or likes. The browser player reports a completion only after an audio asset ends and its duration matches metadata; current seeded tracks have no audio URLs.

The recommendation endpoint accepts only `limit` (1–20; default 10) and always scopes data to the authenticated user's ID. It does not accept a target `userId` and never returns co-listener identities or their histories. Candidates already present in the requester's interaction history and tracks with invalid/missing acoustic profiles are excluded. Its response is `{ "items": [{ "trackId", "title", "artist", "score", "reason" }], "strategy", "explanation" }`; cold-start users get an empty `items` array until usable data exists.

The implementation-defined content model weights BPM similarity 35%, Camelot relationship 30% (same/adjacent/relative/clash = 1.0/0.8/0.6/0), energy similarity 20%, and valence similarity 15%. BPM similarity decreases linearly with absolute BPM difference over a 60 BPM scale. A listen contributes a profile weight of `playedSeconds / durationSeconds`, capped at 1; explicit likes or full completions contribute 1. This recommender uses the shared Camelot relation helper but does not impose the segue's BPM/Camelot hard eligibility rules or alter its 50/30/20 ranker.

Collaborative scores use only server-linked co-listeners with at least two distinct engaged tracks, and collaborative blending is enabled after at least two such co-listeners are available. A supported recommendation combines 65% acoustic score and 35% co-listener engagement score; when that history is sparse, the rail falls back to content-based ranking. Scores tie-break by `trackId`, so output is deterministic. These thresholds and weights fill details the PRD leaves unspecified and are not trained model parameters.

Offline evaluation is a Jest fixture, not production user history: two training interactions seed an acoustic profile; three separately held-out relevant track IDs are not passed into recommendation generation; five candidates are ranked and scored with Precision@5. The current fixture result is 3/5 = 0.6. It meets the numeric target on that small synthetic fixture only; it does not establish real-user relevance or model effectiveness.

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

For segue banter, `sourceEvents` contains stable field pointers such as `trackId#title`, `trackId#acoustic.bpm`, and timeline pointers `trackId#timeline[index]`. The deterministic script uses the current and selected track's stored title/artist, their stored BPM/key/energy plus the matcher's computed compatibility result, and the first non-empty timeline entry from each track when present. The default `deterministic_fallback` is used when no optional transition provider is configured; if an injected provider fails or returns an invalid shape, the same fallback is used. No external LLM provider is configured or called. Provider injection is an internal JavaScript service seam, not a configured external integration.

When a segue is selected, the REST service publishes `lounge.ai.dj_announcement` to the matching Socket.io Lounge room. Its payload follows the PRD shape exactly: `{ "text", "relatedTrackId", "sourceEvents" }`. It does not broadcast to other Lounge rooms. A no-match response does not emit an announcement.

### Grounded current-track Q&A

`POST /api/v1/lounges/:id/ai/ask` accepts `{ "question": "Where does the sample come from?" }`. It requires a JWT and membership in the active Lounge; the track is derived from the Lounge's `currentTrackId`, so callers cannot ask about arbitrary tracks or another Lounge's catalog context. Any member role may ask. Questions must be 3–500 plain-text characters, and each member is limited to 10 requests per Lounge per rolling minute (process-local).

The service retrieves only the current Track document's validated identity fields (`title`, `artist`), acoustic profile (`bpm`, `camelotKey`, `energy`, `valence`), and embedded `timeline` entries (`sample_credit`, `trivia`, `glossary`). It uses deterministic lexical term matching and safe field templates; timeline responses quote the retrieved entry verbatim. It returns `{ "trackId", "answer", "sourceEvents", "grounded", "provider" }`. Source pointers are `trackId#title`, `trackId#artist`, `trackId#acoustic.<field>`, or `trackId#timeline[index]`. When no relevant supported field or timeline entry exists, the service says the information is unavailable, sets `grounded: false`, and returns `sourceEvents: []`.

This is a small retrieval-and-extractive-answer implementation, not generative RAG: no LLM, embedding model, vector database, web search, or external knowledge source is configured. The PRD allows a hosted or local model but does not require a particular provider; avoiding an unconfigured model prevents unsupported claims. Recently played tracks are not supported because this backend has no Lounge playback-history event. The request limiter is process-local and Q&A request counts are not yet persisted for session analytics.

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
| `lounge.soundclash.submit` | `{ "trackId": "t_2003" }` | Listener member submits one unique, unqueued track to the current Soundclash collection. |
| `lounge.soundclash.open` | `{}` | Host member opens voting once 2–4 Listener-submitted candidates are collected. |
| `lounge.soundclash.vote` | `{ "battleId": "<battle id>", "trackId": "t_2003" }` | Listener member casts one immutable vote for one candidate before the server deadline. |
| `lounge.soundclash.resolve` | `{ "battleId": "<battle id>", "winningTrackId": "t_2003" }` | Host or Co-DJ resolves a closed tie by selecting one of the tied candidates. |

Queue mutation commands are frozen for everyone when the Host has no connected socket in the Lounge. Reconnecting the Host clears that state. A vote that does not change a participant's existing vote returns current state without writing another event.

### Broadcast events

| Event | Payload | Contract |
|---|---|---|
| `lounge.queue.update` | `{ "queue": [{ "trackId": "t_2001", "position": 0 }], "reason": "add" }` | Broadcast to all Lounge sockets after a persisted queue command. Position `0` is Now Playing; following positions are Next Up. PRD reasons `vote`, `segue`, and `battle` remain reserved for those operations; this increment also uses `add` for explicit Host/Co-DJ queue additions. |
| `lounge.presence.update` | `{ "participantId": "<user id>", "action": "joined", "participantCount": 2, "hostDisconnected": false }` | Broadcast when a participant's first socket joins or last socket leaves. `participantCount` counts users, not tabs. |
| `lounge.sync.pong` | `{ "clientSentAt": 1792490000000, "serverReceivedAt": 1792490000001 }` | Returned to the requesting socket for latency measurement. |
| `lounge.chat.message` | `{ "messageId": "<uuid>", "userId": "<user id>", "body": "This set is amazing!", "sentimentBucket": "positive", "tsSeconds": 1792490000 }` | Emitted only to sockets in the authorized Lounge room after acceptance. `userId` and sentiment are server-derived; client-supplied identity or bucket fields are rejected. `tsSeconds` is server Unix time. |
| `lounge.sentiment.score` | `{ "rollingScore": 1, "windowSeconds": 300, "sampleSize": 1 }` | Emitted to the same Lounge after each accepted message. Score is 0–1, with 0.5 neutral; sample size counts messages in the rolling window. |
| `lounge.soundclash.open` | `{ "battleId": "<battle id>", "candidateTrackIds": ["t_2003", "t_2004"], "closesAt": 1792490030000 }` | Exact PRD §7.3.4 envelope and payload. `closesAt` is a Unix timestamp in milliseconds. |
| `lounge.soundclash.resolved` | `{ "battleId": "<battle id>", "winningTrackId": "t_2003" }` | Exact PRD §7.3.4 envelope and payload, emitted after the durable winner event has been applied. |
| `lounge.soundclash.submission` | `{ "battleId": "<battle id>", "trackId": "t_2003", "submittedByUserId": "<user id>", "candidateCount": 2 }` | Additive event for live candidate-list updates; the PRD does not define its payload. |
| `lounge.soundclash.vote` | `{ "battleId": "<battle id>", "voteCounts": { "t_2003": 1 }, "closesAt": 1792490030000 }` | Additive live tally event; a closed tie adds `status: "tied"`. The PRD does not define its payload. |
| `lounge.ai.dj_announcement` | `{ "text": "AstraDJ deterministic fallback: …", "relatedTrackId": "t_2003", "sourceEvents": ["t_2003#timeline[0]"] }` | Optional metadata-grounded announcement using the existing deterministic segue provider; no LLM is connected. |

`lounge.sync.ping` is accepted as a client command and its matching pong is emitted to that client. Queue update broadcasts currently include ordered track IDs; clients can resolve titles/artwork through the catalog endpoints.

### Lounge chat and sentiment

Chat accepts only `{ body }`. The server NFKC-normalizes text, removes control characters and HTML-like tags, trims whitespace, and accepts 1–500 Unicode code points after sanitization. Each user is limited to five accepted messages per Lounge per rolling 10 seconds. Authentication, joined socket state, persisted `participantIds` membership, and current user role are checked server-side on every command. History reads use the same authorization and cannot select a Lounge ID from the client.

Messages are buffered per Lounge and persisted as `ChatMessage` documents in batches of 20 or after one second. Mongo writes use message-ID upserts so a retry does not duplicate a message; graceful shutdown flushes pending chat batches. `lounge.chat.history` returns at most 100 recent messages, including messages in the write buffer, for reconnect/context restoration. Stored records include `msgType: "chat"`, the bucket, and its 0–1 numeric score.

The PRD does not specify a classifier, score scale/formula, or aggregation duration. This implementation uses a deliberately small deterministic English keyword lexicon (not ML): buckets are `positive`, `neutral`, or `negative`; bucket values map to 1, 0.5, and 0 respectively; room score is their arithmetic mean over the previous 300 seconds. This behavior is testable but sentiment accuracy is **not evaluated** and the PRD's 85% KPI is not claimed. Empty windows report neutral `0.5` with `sampleSize: 0`. The segue service trusts room sentiment only after at least three recent messages; with fewer messages it supplies neutral `0.5` to the unchanged acoustic matcher, preserving the current track's energy target. The existing `currentSentimentScore` request field remains required for request compatibility but is not authoritative.

Chat buffers, sentiment windows, and rate-limit state are process-local. A single API process is supported; multi-replica synchronization and distributed rate limiting are not implemented. Typing indicators and emoji reactions named in the broader PRD remain unimplemented because their event payload contracts are unspecified.

### Soundclash

Only authenticated Lounge members may use Soundclash commands, and persisted Lounge membership is rechecked for every command. Listener is the only role allowed to submit and vote. A Listener may submit one catalog track and cast one immutable vote per battle. Submitted tracks must exist, must not be current or already queued, and must not duplicate another candidate. The Host opens a battle after 2–4 candidates have been collected. The server uses a 30-second voting window because the PRD requires timed voting but does not specify a duration; `closesAt` is Unix milliseconds. Command conventions, one-per-user limits, 30 seconds, and zero-vote ties are implementation choices for details the PRD leaves open.

At the deadline, a unique highest-vote candidate is automatically spliced at position 1 (Next Up) and persisted as a queue event. Equal top counts, including a zero-vote tie, remain unresolved until a Host or Co-DJ selects one of the tied tracks. Manual queue operations remain frozen while the Host is disconnected; the server-owned timer can still tally and apply a unique winner. Queue state is reconstructed from the append-only `QueueEvent` log after restart, and an open battle's deadline is re-armed from the stored `closesAt`.

An optional announcement uses the existing deterministic transition fallback and cites only catalog timeline metadata when available. It is not LLM-generated; no AI provider is configured. The PRD mentions an AI DJ opening battles, but no automatic opening trigger or AI provider is implemented. Separate relational `soundclash_battles` tables are not used: compact battle commands and results are stored in `QueueEvent`, consistent with the append-only event architecture.

### Error codes

`VALIDATION_ERROR` indicates malformed invite, track, vote, timestamp, chat, or Soundclash input; `CHAT_RATE_LIMITED` indicates more than five chat messages in ten seconds; `LOUNGE_NOT_FOUND` indicates an invalid/ended invite or missing room; `LOUNGE_FULL` indicates participant capacity; `LOUNGE_MEMBERSHIP_REQUIRED` indicates a protected command before join; `FORBIDDEN` indicates an insufficient role; `TRACK_NOT_FOUND` or `TRACK_NOT_QUEUED` indicates an invalid target; `TRACK_ALREADY_QUEUED` indicates a duplicate add; `SOUNDCLASH_NOT_COLLECTING`, `SOUNDCLASH_ALREADY_ACTIVE`, `SOUNDCLASH_CLOSED`, `SOUNDCLASH_NOT_TIED`, and `SOUNDCLASH_DUPLICATE_VOTE` indicate invalid battle state or repeat actions; `INVALID_TIE_WINNER` indicates a Host/Co-DJ selected a non-leading candidate; `HOST_DISCONNECTED` indicates frozen manual queue operations; `AUTH_REQUIRED` and `INVALID_TOKEN` indicate failed authentication.

## Persistence and recovery

The in-memory queue holds ordered track IDs, current Now Playing ID, vote maps, and revision. MongoDB stores compact append-only `QueueEvent` commands (`track.added`, `track.voted`, and Soundclash submission/open/vote/tie/resolution events) with a unique `(loungeId, seq)` index. Queue additions and Soundclash state changes are persisted immediately; queue-vote events use the existing per-Lounge batch. A process crash can lose the most recent unflushed vote batch, while immediate battle transitions remain durable. On first access after restart, the service loads the Lounge's persisted starting queue and replays durable events in sequence. Full queue snapshots are not written on each vote. A single API process is the supported runtime for this in-memory state; multiple replicas need coordinated state and a Socket.io adapter before deployment.

## Local verification

```powershell
cd server
npm test
```

The Socket.io suite creates an actual local Socket.io server and clients but injects an in-memory repository. Optional `tests/segue.mongo.integration.test.js` and `tests/chat.mongo.integration.test.js` suites use `MONGODB_TEST_URI`, create unique temporary databases, exercise real Mongoose persistence, and drop only those test databases in cleanup. Soundclash realtime tests use local sockets with the in-memory repository; its Mongo event-log replay is covered by a fake repository, not a separate live Mongo integration test. Do not point integration tests at production data. For a local MongoDB without credentials, set `MONGODB_TEST_URI=mongodb://127.0.0.1:27017` in the shell before running the full suite. The current `server/.env` is absent, so the API's normal runtime connection and production seed have not been configured or run.
