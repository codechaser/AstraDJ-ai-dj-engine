# AstraDJ

AstraDJ is a reference-led music experience. Its existing React + Vite frontend remains in the repository root. The new API is a separate JavaScript package under `server/`.

## Track and technology stack

**Track A — Full-Stack (Option B / MERN)**, as specified by the internship PRD.

- Client: React + Vite, JavaScript, Tailwind CSS, React Router
- API: Node.js + Express.js
- Database: MongoDB + Mongoose
- Real-time gateway: Socket.io (authenticated Lounge join, shared queue, presence, sync and reconnect)
- Authentication: JWT access token plus rotating refresh cookie
- Tests: Jest + Supertest, Playwright for real-browser audio E2E

Account/Profile, Search, shared Lounge queue, live chat, sentiment, Soundclash, recommendation shelves, AI DJ Q&A/segue actions, and Lounge analytics use existing backend APIs or Socket.io events. Home artist/vibe/trending content and Playlist/Artist/Album details remain explicitly marked sample previews; settings are display-only. No Spotify infrastructure, accounts, catalog, or user data are used.

## Run the frontend

```sh
npm install
npm run dev
```

Build with `npm run build`.

## Run the backend

See [backend setup and endpoint guide](server/README.md). In short, create `server/.env` from `server/.env.example`, set `MONGODB_URI` and a unique `JWT_ACCESS_SECRET` of at least 32 characters, then run:

```sh
cd server
npm install
npm run seed
npm run dev
```

The frontend also uses authenticated recommendations and Lounge analytics, plus room-scoped Socket.io chat, sentiment, Soundclash, and deterministic announcement events. AI Q&A and segue requests use the active Lounge context saved in the current browser session; the backend remains the authority for membership, track state, and match eligibility. Most backend HTTP and Socket.io tests use repository fakes. The opt-in MongoDB suites create and clean up uniquely named `astradj_test_*` databases; configure a dedicated test service in `server/.env.test` from `server/.env.test.example` and run `npm run test:integration` in `server`. The normal `server/.env` runtime configuration and deployment remain separate and unverified.

The backend also exposes an authenticated, Lounge-member-only acoustic segue endpoint at `POST /api/v1/lounges/:id/ai/segue`. It applies BPM/Camelot rules, ranks eligible tracks, and uses a metadata-grounded deterministic fallback until an AI provider is configured. See [the API reference](server/API.md).

Authenticated Lounge members can also use Socket.io `lounge.chat.message` and `lounge.chat.history`. Messages are sanitized, rate-limited, persisted in MongoDB batches, and broadcast with a deterministic rolling room-sentiment score. The keyword scorer is not ML and its accuracy has not been evaluated. See [the API reference](server/API.md) for event payloads and fallbacks.

The real-time gateway also supports Listener track submissions and votes for a Host-opened Soundclash, server-timed resolution, tie resolution by Host or Co-DJ, and queue insertion at Next Up. Its PRD-defined `.open` and `.resolved` events retain their exact payloads. A deterministic metadata-grounded announcement is used; no AI provider is connected. See [the Soundclash contract](server/API.md#soundclash) for implementation choices where the PRD is silent.

The backend records authenticated listening interactions and serves a private hybrid recommendation rail from acoustic profiles and co-listener reports. The player reports a completion only after a catalog audio asset ends and its duration matches metadata; the CC0 demo is catalog track `t_cc0_thoughtness` and is discoverable in Playlist/Search. Its acoustic profile is intentionally null because no analysis was verified, so it is excluded from segue and recommendations. A Playwright E2E test now verifies actual Chrome Ogg playback at normal speed, pause/resume, natural completion through the player's `ended` handler, authenticated history ownership, and incomplete-play behavior using a disposable local database. These records remain app-observed/client-reported, not independent playback telemetry. Recommendations return an empty cold-start result when no supported history exists. A small synthetic held-out fixture measures Precision@5 at 0.6; this is not an effectiveness claim for real users. See [the interaction and recommendation contract](server/API.md#recommendations-and-listening-interactions) and [the audio asset notice](public/audio/NOTICE.md).

Lounge members can ask grounded questions about the current track through `POST /api/v1/lounges/:id/ai/ask`. Answers use only the track title/artist, validated acoustic profile, and embedded metadata timeline, with stable source references; unsupported questions return an explicit unavailable answer. Transition banter uses the same stored track facts and acoustic match result, and publishes the PRD-shaped `lounge.ai.dj_announcement` event to that Lounge. These paths use deterministic retrieval/templates and fallback text; no LLM, embeddings, or vector store is configured. See [the AI DJ API contract](server/API.md#grounded-current-track-qa).

## Current UI routes

`/`, `/ai-dj`, `/now-playing`, `/search`, `/playlist`, `/queue`, `/artist`, `/profile`, `/album`, and `/settings`. Mobile layouts are responsive states of these routes.

## Requirements tracking

See [the PRD compliance matrix](docs/prd-compliance.md) for implementation evidence, verification limits, and remaining requirements. The source PRD is stored at `docs/reference/Internship-PRD.docx`.

## Dashboard history and analytics increment

The authenticated dashboard API exposes the caller's self-reported interaction history and Lounge analytics for persisted queue events, Soundclash openings, chat counts, and the chat sentiment timeline. Session duration, peak concurrent participants and AI DJ question counts are unavailable because the session start, durable presence peaks and question events are not recorded. The Account/Profile route now authenticates against the backend. The player uses browser audio only when a track has an `audioAssetUrl`; the catalog-seeded CC0 demo has a real asset, while mock selections are never written as listens. See [dashboard API details](server/API.md#dashboard-history-and-lounge-analytics).

For local Vite development, set `VITE_DEV_API_TARGET` if the API is not at the dev default. Production can set `VITE_API_BASE_URL` at build time and the backend `CLIENT_ORIGIN` to the exact frontend origin. Refresh cookies are SameSite=Strict, so the app and API must be same-origin or same-site; no local-only API URL is embedded in the production client bundle.

## Real-browser audio verification

Install the root dependencies and Chrome, create `server/.env.test` from `server/.env.test.example`, and set `MONGODB_TEST_URI` to a local, disposable MongoDB database whose name contains `test`. Run `npm run test:e2e:audio` from the repository root. The runner refuses remote or non-test database targets, creates a uniquely named `astradj_e2e_*` database, seeds it, starts the API and Vite with test-only credentials, then drops only that database after the run. The test registers throwaway accounts through the UI and uses actual Chrome Ogg playback at normal speed; it waits for the real track end, then verifies the authenticated interaction/history and isolation. It requires Chrome and local MongoDB to be available.
