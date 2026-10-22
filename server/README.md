# AstraDJ backend setup

This backend follows PRD Option B: Node.js, Express.js, MongoDB, Mongoose, and Socket.io. The existing AstraDJ Vite frontend remains at the repository root; Account/Profile, Search, player boundary, Queue, Lounge chat/Soundclash, recommendations, AI Q&A/segue, and authorized Lounge analytics now connect to existing API/socket contracts while retaining the established design.

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

The client defaults to same-origin `/api/v1` and Socket.io paths. For local Vite development, set `VITE_DEV_API_TARGET` if the API is not at `http://localhost:4000`. For production, set `VITE_API_BASE_URL` at build time and set backend `CLIENT_ORIGIN` to the exact frontend origin. Credentialed refresh cookies use SameSite=Strict, so deploy the frontend/API same-origin or on the same site (for example sibling subdomains) over HTTPS; a same-origin reverse proxy is the simplest setup.

The Settings screen persists its supported audio preference controls to the authenticated user's existing `preferences.audio` document: streaming quality, crossfade choice, normalize volume, lyrics visibility, AI DJ commentary, download quality, and autoplay. Use `GET`/`PATCH /api/v1/auth/me/preferences`; the API validates a fixed allowlist and scopes access from the bearer token. These values currently persist as preferences and are not all applied to the audio playback engine.

By default, the API listens on `http://localhost:4000`. `GET /health` reports service and database connection state. The server validates its environment and connects to MongoDB before listening. `JWT_ACCESS_TTL_SECONDS` defaults to 900 and is restricted to 1–3600 seconds. Refresh tokens are random, stored only as SHA-256 hashes, rotated on use, and sent in an HttpOnly, SameSite=Strict cookie. In production the cookie is Secure.

To create a Host for local development, first register an account, then use a privileged MongoDB administrator session to set that account's `role` to `Host`. Registration deliberately ignores client-supplied roles. Do not add a public role-promotion endpoint.

Seed the fictional three-track catalog with `npm run seed`. The authored acoustic profiles form a valid segue chain. The values and lore are synthetic; no licensed or Spotify catalog data is included.

Run mocked/unit and service suites with `npm test`. For genuine MongoDB integration suites, copy `.env.test.example` to `.env.test` and set `MONGODB_TEST_URI` to a dedicated local or disposable test service, then run `npm run test:integration`. Node loads only `.env.test` for that script; `server/.env` remains separate. Each integration test generates a unique `astradj_test_<suite>_<random-id>` database, and the shared cleanup helper verifies the name before dropping it. Never point the test URI at production data. Integration coverage includes real auth registration/login and user/refresh-token and settings persistence, account isolation, catalog/acoustic-profile reads, interaction/history persistence, chat, segue, recommendations/co-listener linking, queue-event storage, and persisted analytics/member authorization. It does not run the Socket.io Soundclash service against Mongo; that service's behavior remains covered with fake repositories and local sockets.

For a real-browser audio lifecycle check, install the repository-root dependencies and Chrome, configure this same `.env.test` with a local disposable test database, then run `npm run test:e2e:audio` from the repository root. The runner validates the Mongo host and test database name, generates a separate `astradj_e2e_*` database, starts the API/Vite with ephemeral test credentials, and drops only that generated database after the test. Playwright signs up two test-only accounts through the normal UI, loads `t_cc0_thoughtness`, verifies Ogg metadata and actual progress/pause/resume/natural completion at normal speed, then checks owner-only history and that a paused incomplete play creates no record. This verifies the app's browser-observed path in the tested local Chrome run; interaction records remain self-reported client telemetry.

To verify the Host Lounge journey, run `npm run test:e2e:lounge` from the repository root with the same `.env.test` configuration. The runner creates a unique local database and test-only Host, launches Chrome, creates a catalog-backed Lounge through the Queue UI, and checks that a separately authenticated Listener can join by the returned invite code and receive its current track. Only the generated E2E database is removed after the run.

To verify Settings persistence in Chrome, run `npm run test:e2e:settings` from the repository root with the same safe `.env.test` setup. The browser registers accounts through the UI, confirms six unsupported capability controls are disabled, changes AI DJ commentary, reloads, signs out/in, and checks a second account's defaults; a separately intercepted 503 verifies the UI reports a failed save without changing the displayed saved value. AI DJ commentary affects segue-script and Lounge announcement display; other preferences remain stored-only. Database writes and account isolation are also verified by the Mongo integration test.

To verify Home and catalog screens in Chrome, run `npm run test:e2e:catalog` from the repository root with the same safe `.env.test` setup. It checks catalog-backed Home artist/track cards, artist tracks, Playlist rows, player selection and the Album metadata gap against a generated disposable MongoDB database. Mocked empty/error responses separately verify those UI states.

Lounge session analytics use persisted start/end timestamps, distinct Soundclash battle IDs from `QueueEvent`, timestamped chat/sentiment records, and append-only `LoungeMetricEvent` presence and AI-question rows. New sessions mark their analytics event coverage version; legacy sessions without that marker report peak presence and question count as unavailable. Presence counts unique users (first socket join through last socket leave). AI Q&A requires an `Idempotency-Key`; a repeated key for the same Lounge/user does not add another question event, and question text is not stored. End summaries and history/analytics reads reconcile from durable sources; analytics responses omit user IDs, invite codes, and private chat content. See `API.md#dashboard-history-and-lounge-analytics` for semantics and edge cases.

## Endpoints in this increment

- `POST /api/v1/auth/register` — creates a Listener account; ignores any submitted `role`.
- `POST /api/v1/auth/login` — verifies credentials and issues access/refresh credentials.
- `POST /api/v1/auth/refresh` — rotates the refresh cookie and returns a new access token.
- `POST /api/v1/auth/logout` — revokes the presented refresh token.
- `GET /api/v1/auth/me` — authenticated account profile.
- `GET /api/v1/auth/me/preferences` and `PATCH /api/v1/auth/me/preferences` — authenticated, validated audio preferences for the current account.
- `GET /api/v1/tracks` — validated paginated catalog (`q`, `limit`, `skip`).
- `GET /api/v1/tracks/:trackId/acoustic-profile` — PRD-shaped track vector and metadata timeline.
- `POST /api/v1/tracks` — Admin-only validated acoustic-profile management endpoint.
- `POST /api/v1/lounges` — Host-only lounge creation using the PRD request and response contract.
- `POST /api/v1/lounges/:id/ai/segue` — authenticated Lounge-member acoustic selection and grounded deterministic transition fallback.
- `POST /api/v1/lounges/:id/ai/ask` — authenticated Lounge-member current-track Q&A with metadata source references.
- `POST /api/v1/interactions` — authenticated self-reported listening event with optional verified live Lounge context.
- `GET /api/v1/recommendations?limit=10` — private, authenticated hybrid recommendation rail for the current user.
- `GET /api/v1/dashboard/playback-history?limit=20` — authenticated current-user view of existing self-reported interactions (not player-verified history).
- `GET /api/v1/dashboard/lounge-history?limit=50` — authenticated list of ended Lounge summaries where the caller is Host or a persisted participant.
- `GET /api/v1/dashboard/lounges/:id/analytics` — Lounge-member analytics from persisted queue events and chat messages; unavailable metrics remain `null`.
- `GET /health` and `GET /api/v1/health` — API and database state.

## Socket.io DJ Lounge queue

Connect to the same API origin with `io(API_ORIGIN, { auth: { token: ACCESS_JWT } })`, then emit `lounge.join` with an invite code. The gateway authenticates the JWT at handshake, resolves the invite server-side, enforces capacity and membership, and acknowledges with the current complete queue state. Queue mutations are authoritative, append compact `QueueEvent` commands, and broadcast the PRD `lounge.queue.update` event. Queue state and vote tallies are reconstructed from the persisted Lounge seed and event log after a process restart. See [API and Socket.io reference](API.md) for payloads, acknowledgements, event envelopes, validation failures, and role rules.

The in-memory room state is per process. This implementation supports multiple Lounge IDs in one API process; running multiple API replicas would require a shared Socket.io adapter and coordinated queue state, and is not claimed here. The 50 participant configuration maximum is enforced at join time; capacity/performance has not been load-tested. The first successful join changes `scheduled` to `live` and records `startedAt`. The owning Host ends with `lounge.session.end`; connected members receive `lounge.session.ended`, and repeat end commands return the existing summary without duplicate writes. Ended invites cannot rejoin and queue/chat/Soundclash mutations are rejected, while Host and participants can read the summary from Lounge History in Profile.

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

Live join, shared queue add/vote ordering, presence, sync/reconnect, queue recovery, deterministic acoustic matching, authenticated segue/Q&A, scoped announcements, chat/history/sentiment, Soundclash, recommendations, dashboard endpoints, and user-scoped audio preference persistence are implemented and covered by automated tests. Seven Audio preferences persist. AI DJ commentary controls segue-script and Lounge DJ announcement presentation; the other six are saved-only and disabled because their required playback capabilities are missing. Other Settings categories remain previews. Home artist/track displays and Playlist/Artist pages now use catalog API results; the recommendation rail uses its authenticated endpoint. The catalog has no playlist entities, album data, artwork, genre/mood, bios, listener counts, or popularity signals, so those are not claimed and the Album page reports the gap. The Queue screen connects Host Lounge creation, invite joining, active-room rejoin and confirmed session ending. The Lounge E2E verifies Host create/rejoin, Listener join, both clients' end-event update, persistent analytics, owner/member history and unrelated-user denial against isolated local MongoDB. New sessions record durable presence and accepted AI-question events; legacy coverage remains unavailable. Mongo integration tests exercise full analytics reconciliation from actual source rows. Recently played Q&A, generative LLM RAG, embeddings/vector search, external knowledge/lyrics, independent server-side playback attestation, a generated production interaction corpus, typing indicators, emoji reactions, moderation, and Admin acoustic upload UI remain incomplete or unverified. The recommendation fixture's Precision@5 is 0.6 but does not establish real-user effectiveness. The player uses catalog-seeded CC0 demo `t_cc0_thoughtness` (`/audio/thoughtness.ogg`); acoustic analysis is absent. Catalog, audio, Lounge, and Settings Playwright tests exercise local Chrome against disposable databases; 50-user load evidence is pending. See `../docs/prd-compliance.md` and `../docs/prd-gap-audit.md` for the audit.

## Audio assets

`Track.audioAssetUrl` is optional. The API accepts local `/audio/<filename>.<ext>` assets that live under the frontend's `public/audio/` directory, or exact-host HTTPS sources listed in `AUDIO_ASSET_ALLOWED_HOSTS` (comma-separated, no wildcards/ports). Plain HTTP, local filesystem URLs, traversal paths, and unlisted media hosts are rejected. Add only assets the project is authorized to serve and record their provenance/license in `public/audio/NOTICE.md`. The CC0 demo file `public/audio/thoughtness.ogg` is seeded as catalog track `t_cc0_thoughtness`; Playlist/Search load it from `GET /api/v1/tracks`. Its acoustic profile is null until verified analysis exists and it is therefore ineligible for acoustic matching. The Ogg stream duration is 46.132 seconds, represented as 46 seconds in the catalog. Playback history is reported only after the browser audio element's `ended` event with duration within one second, and remains labeled `self_reported`. `npm run test:e2e:audio` verifies Ogg response/metadata, actual progress, pause/resume, natural completion, owner-scoped history, and no history for a paused incomplete play in installed Chrome using an isolated local MongoDB database. This does not attest playback independently of the client.

## Dashboard history and Lounge analytics

`GET /api/v1/dashboard/playback-history` returns only the caller's own Interaction rows and preserves `source: self_reported`; this is not independent playback verification. When an `audioAssetUrl` exists, the browser player writes one completed Interaction only from the audio element's `ended` event and only when observed duration matches track metadata within one second. The CC0 demo is seeded as `t_cc0_thoughtness`; `npm run test:e2e:audio` verifies this flow in local Chrome against an isolated test database, including second-user isolation and paused incomplete playback. `GET /api/v1/dashboard/lounges/:id/analytics` is available to the host and persisted participants, including for ended rooms. Session duration comes from persisted start/end times; queue/Soundclash counts use event rows/unique battle IDs; chat counts and sentiment points use timestamped ChatMessage records. New sessions also persist unique-user presence edges and accepted AI-question IDs. Legacy sessions without complete analytics coverage report those metrics as unavailable. See `API.md#dashboard-history-and-lounge-analytics` for reconciliation and privacy semantics.
