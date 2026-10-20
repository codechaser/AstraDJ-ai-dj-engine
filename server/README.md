# AstraDJ backend setup

This backend follows PRD Option B: Node.js, Express.js, MongoDB, Mongoose, and Socket.io. The existing AstraDJ Vite frontend remains at the repository root and is not connected to live queue data yet; its reference screens and styling are unchanged.

## Requirements

- Node.js 20 or later
- MongoDB 6 or later, local or remote

## Configure and run

```powershell
cd server
Copy-Item .env.example .env
```

Set `MONGODB_URI` to your MongoDB connection string. Replace `JWT_ACCESS_SECRET` with a unique random secret of at least 32 characters. Do not commit `.env`; `.env.example` contains placeholders only.

```powershell
npm install
npm run seed
npm run dev
```

By default, the API listens on `http://localhost:4000`. `GET /health` reports service and database connection state. The server validates its environment and connects to MongoDB before listening. `JWT_ACCESS_TTL_SECONDS` defaults to 900 and is restricted to 1–3600 seconds. Refresh tokens are random, stored only as SHA-256 hashes, rotated on use, and sent in an HttpOnly, SameSite=Strict cookie. In production the cookie is Secure.

To create a Host for local development, first register an account, then use a privileged MongoDB administrator session to set that account's `role` to `Host`. Registration deliberately ignores client-supplied roles. Do not add a public role-promotion endpoint.

Seed the fictional three-track catalog with `npm run seed`. The authored acoustic profiles form a valid segue chain. The values and lore are synthetic; no licensed or Spotify catalog data is included.

Run the backend suite with `npm test`. Jest + Supertest verify most HTTP contracts using repository fakes, Socket.io client/server tests exercise real local WebSocket sessions against an isolated fake repository, and direct Mongoose schema tests validate document constraints. The opt-in `tests/segue.mongo.integration.test.js`, `tests/chat.mongo.integration.test.js`, and `tests/recommendations.mongo.integration.test.js` suites use `MONGODB_TEST_URI`, create unique temporary MongoDB databases, and drop those test databases. Do not point them at production data. `MONGODB_TEST_URI` and the app's normal `server/.env` were absent in the latest test run, so all three Mongo suites were skipped and the production seed was not run.

## Endpoints in this increment

- `POST /api/v1/auth/register` — creates a Listener account; ignores any submitted `role`.
- `POST /api/v1/auth/login` — verifies credentials and issues access/refresh credentials.
- `POST /api/v1/auth/refresh` — rotates the refresh cookie and returns a new access token.
- `POST /api/v1/auth/logout` — revokes the presented refresh token.
- `GET /api/v1/auth/me` — authenticated account profile.
- `GET /api/v1/tracks` — validated paginated catalog (`q`, `limit`, `skip`).
- `GET /api/v1/tracks/:trackId/acoustic-profile` — PRD-shaped track vector and metadata timeline.
- `POST /api/v1/tracks` — Admin-only validated acoustic-profile management endpoint.
- `POST /api/v1/lounges` — Host-only lounge creation using the PRD request and response contract.
- `POST /api/v1/lounges/:id/ai/segue` — authenticated Lounge-member acoustic selection and grounded deterministic transition fallback.
- `POST /api/v1/lounges/:id/ai/ask` — authenticated Lounge-member current-track Q&A with metadata source references.
- `POST /api/v1/interactions` — authenticated self-reported listening event with optional verified live Lounge context.
- `GET /api/v1/recommendations?limit=10` — private, authenticated hybrid recommendation rail for the current user.
- `GET /api/v1/dashboard/playback-history?limit=20` — authenticated current-user view of existing self-reported interactions (not player-verified history).
- `GET /api/v1/dashboard/lounges/:id/analytics` — Lounge-member analytics from persisted queue events and chat messages; unavailable metrics remain `null`.
- `GET /health` and `GET /api/v1/health` — API and database state.

## Socket.io DJ Lounge queue

Connect to the same API origin with `io(API_ORIGIN, { auth: { token: ACCESS_JWT } })`, then emit `lounge.join` with an invite code. The gateway authenticates the JWT at handshake, resolves the invite server-side, enforces capacity and membership, and acknowledges with the current complete queue state. Queue mutations are authoritative, append compact `QueueEvent` commands, and broadcast the PRD `lounge.queue.update` event. Queue state and vote tallies are reconstructed from the persisted Lounge seed and event log after a process restart. See [API and Socket.io reference](API.md) for payloads, acknowledgements, event envelopes, validation failures, and role rules.

The in-memory room state is per process. This implementation supports multiple Lounge IDs in one API process; running multiple API replicas would require a shared Socket.io adapter and coordinated queue state, and is not claimed here. The 50 participant configuration maximum is enforced at join time; capacity/performance has not been load-tested.

## Soundclash

Listeners can submit one catalog track and vote once per battle. The Host opens a battle after 2–4 candidates; a 30-second server timer closes voting, applies a unique winner at Next Up, or leaves tied leaders for Host/Co-DJ resolution. Soundclash commands and outcomes are stored in the append-only `QueueEvent` log and replayed for reconnect/restart. The PRD-defined `lounge.soundclash.open` and `.resolved` payloads are exact; command shapes, the timer duration, per-user limits, and zero-vote tie handling are documented implementation decisions because the PRD does not define them. The optional announcement is metadata-grounded deterministic fallback text, not LLM output. See [the event reference](API.md#soundclash).

## Interactions and recommendations

Authenticated users can record their own listen reports with `POST /api/v1/interactions`; the server stores the token owner, track, reported seconds, completion and like flags, and optional Lounge context. Queue additions/votes are never treated as listens. Lounge context is accepted only for a persisted member and the current track of a live room; the server links users who report the same Lounge track within ten minutes. These are self-reported interactions, not playback-verified telemetry.

`GET /api/v1/recommendations` returns only the caller's ranked rail. It blends acoustic similarity with co-listener engagement when at least two co-listeners each have two engaged tracks; sparse history falls back to content ranking, and cold-start history returns no invented items. The feature weights and thresholds are explicit implementation choices because the PRD defines the hybrid inputs but not formulas. A synthetic held-out test fixture has Precision@5 = 0.6 (3/5); it is not evidence of real-user relevance. The endpoints, data shape, and scoring are documented in [the API reference](API.md#recommendations-and-listening-interactions).

### Grounded AI DJ questions and banter

`POST /api/v1/lounges/:id/ai/ask` is restricted to an authenticated member of that live Lounge and answers only for its current track. It uses lexical retrieval over the stored title/artist, validated acoustic profile, and embedded metadata timeline. Answers cite actual Track fields/timeline entries, quote retrieved timeline text, and decline unsupported questions. Requests are limited to 10 per member per Lounge per rolling minute in the current process. The REST contract and source-pointer formats are in [the API reference](API.md#grounded-current-track-q-a).

Segue banter includes the selected match's tempo/key facts and cites the current/candidate Track fields plus any quoted timeline entries. The existing `lounge.ai.dj_announcement` Socket.io event carries the exact PRD payload and is emitted to that Lounge only. The implementation uses deterministic retrieval and templates, not a connected LLM, vector search, embeddings, lyrics database, artist-bio corpus, or external sources. Recently played Q&A, durable question analytics, and distributed rate limits remain incomplete.

## Lounge chat and room sentiment

Joined authenticated users of every current role may send text with `lounge.chat.message` and request recent messages with `lounge.chat.history`. Messages are sanitized to 1–500 code points, rate-limited to five per user per Lounge per 10 seconds, stored as append-only `ChatMessage` records in batches, and broadcast to that Lounge only. `lounge.sentiment.score` reports the deterministic keyword heuristic over a 300-second window (positive=1, neutral=0.5, negative=0); it is not ML and has no measured accuracy claim. Empty or sparse (<3 messages for segue use) rooms use the neutral 0.5 fallback. See [the event reference](API.md#lounge-chat-and-sentiment).

Validation errors use `{ "error": { "code", "message", "details" } }`; profile responses use the PRD's `trackId`, `title`, `artist`, `acoustic`, and `timeline` fields.

## Current limits

Live join, shared queue add/vote ordering, presence, sync ping/pong, reconnect snapshots, Host-disconnect freeze for manual queue mutations, append-only queue event recovery, deterministic acoustic matching, authenticated segue and current-track Q&A, metadata-grounded announcement events, authenticated room chat/history, deterministic room sentiment, Soundclash submission/voting/timer/tie resolution, interaction recording, and hybrid recommendation ranking are implemented and covered by automated tests. Interaction/recommendation/AI tests use repository or model fakes; Mongo integration remains opt-in and must be verified per run. Recently played Q&A, generative LLM RAG, embeddings/vector search, lyrics/artist-bio sources, playback-verified data, a generated production interaction corpus, full dashboard/history/session analytics, typing indicators, emoji reactions, and other moderation features remain incomplete or unverified. The recommendation fixture's Precision@5 is 0.6 but does not establish real-user effectiveness. The frontend continues to use mock data and was not changed. 50-user load evidence is pending. See `../docs/prd-compliance.md` for the audit.

## Dashboard history and Lounge analytics

`GET /api/v1/dashboard/playback-history` returns only the caller's own Interaction rows and preserves `source: self_reported`; this is not player-verified history. `GET /api/v1/dashboard/lounges/:id/analytics` is available to the host and persisted participants, including for ended rooms. Session duration remains `null` until a start timestamp exists; queue counts, Soundclash openings, chat counts, and sentiment points come from stored documents. Peak concurrent participants and AI DJ question counts also remain `null`, since those events are not durable. The current frontend has neither an authentication flow nor actual audio assets/player, so no mock player selection is written as a playback interaction.
