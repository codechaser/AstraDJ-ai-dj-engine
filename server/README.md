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

Run the backend suite with `npm test`. Jest + Supertest verify most HTTP contracts using repository fakes, Socket.io client/server tests exercise real local WebSocket sessions against an isolated fake repository, and direct Mongoose schema tests validate document constraints. The opt-in `tests/segue.mongo.integration.test.js` uses `MONGODB_TEST_URI` to run the segue HTTP endpoint against a unique temporary MongoDB database, then drops that test database. Do not point it at production data. A local MongoDB is reachable in the current environment and this isolated integration test passed; the app's normal `server/.env` remains absent and the production seed has not been run.

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
- `GET /health` and `GET /api/v1/health` — API and database state.

## Socket.io DJ Lounge queue

Connect to the same API origin with `io(API_ORIGIN, { auth: { token: ACCESS_JWT } })`, then emit `lounge.join` with an invite code. The gateway authenticates the JWT at handshake, resolves the invite server-side, enforces capacity and membership, and acknowledges with the current complete queue state. Queue mutations are authoritative, append compact `QueueEvent` commands, and broadcast the PRD `lounge.queue.update` event. Queue state and vote tallies are reconstructed from the persisted Lounge seed and event log after a process restart. See [API and Socket.io reference](API.md) for payloads, acknowledgements, event envelopes, validation failures, and role rules.

The in-memory room state is per process. This implementation supports multiple Lounge IDs in one API process; running multiple API replicas would require a shared Socket.io adapter and coordinated queue state, and is not claimed here. The 50 participant configuration maximum is enforced at join time; capacity/performance has not been load-tested.

## Lounge chat and room sentiment

Joined authenticated users of every current role may send text with `lounge.chat.message` and request recent messages with `lounge.chat.history`. Messages are sanitized to 1–500 code points, rate-limited to five per user per Lounge per 10 seconds, stored as append-only `ChatMessage` records in batches, and broadcast to that Lounge only. `lounge.sentiment.score` reports the deterministic keyword heuristic over a 300-second window (positive=1, neutral=0.5, negative=0); it is not ML and has no measured accuracy claim. Empty or sparse (<3 messages for segue use) rooms use the neutral 0.5 fallback. See [the event reference](API.md#lounge-chat-and-sentiment).

Validation errors use `{ "error": { "code", "message", "details" } }`; profile responses use the PRD's `trackId`, `title`, `artist`, `acoustic`, and `timeline` fields.

## Current limits

Live join, shared queue add/vote ordering, presence, sync ping/pong, reconnect snapshots, Host-disconnect freeze, append-only queue event recovery, deterministic acoustic matching, the authenticated segue endpoint, authenticated room chat/history, and deterministic room sentiment are implemented and tested. Mongo integration coverage is opt-in and uses/drops unique temporary databases; normal `.env` configuration and production seed remain pending. Chat tests use actual local Socket.io clients with an in-memory repository; the optional chat Mongo integration test exercises real persistence. Sentiment uses a heuristic and its accuracy KPI is unverified. Typing indicators, emoji reactions, Soundclash, conversational RAG, recommendations, analytics, and other moderation features remain incomplete. The frontend continues to use mock data and was not changed. 50-user load evidence is pending. See `../docs/prd-compliance.md` for the audit.
