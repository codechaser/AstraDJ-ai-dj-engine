# AstraDJ

AstraDJ is a reference-led music experience. Its existing React + Vite frontend remains in the repository root. The new API is a separate JavaScript package under `server/`.

## Track and technology stack

**Track A — Full-Stack (Option B / MERN)**, as specified by the internship PRD.

- Client: React + Vite, JavaScript, Tailwind CSS, React Router
- API: Node.js + Express.js
- Database: MongoDB + Mongoose
- Real-time gateway: Socket.io (authenticated Lounge join, shared queue, presence, sync and reconnect)
- Authentication: JWT access token plus rotating refresh cookie
- Tests: Jest + Supertest, Playwright for catalog, audio, Lounge, and settings E2E

Account/Profile, Search, shared Lounge queue, live chat, sentiment, Soundclash, recommendation shelves, AI DJ Q&A/segue actions, Lounge analytics, and supported audio preferences use existing backend APIs or Socket.io events. Home artists/tracks and the Playlist and Artist screens use the public track catalog; recommendations use the private recommendation API. The catalog has no album, artwork, genre/mood, or popularity fields, so the Home labels sections as catalog content and the Album screen explains its missing data. Settings persists seven audio preferences per account; AI DJ commentary affects segue-script and Lounge announcement presentation, while the other six are saved-only and disabled until their underlying playback capabilities exist. No Spotify infrastructure, accounts, catalog, or user data are used.

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

The backend exposes the authenticated manual segue endpoint and a Host-only playback-driven Socket.io lifecycle. With compatible tracks in the shared queue, the configured outro-window trigger chooses a grounded segue; the shared current track changes only after the browser's actual audio `ended` event. The 10× accelerated Chrome E2E verifies both directions of the source-backed CC0 pair. See [the API reference](server/API.md).

Authenticated Lounge members can also use Socket.io `lounge.chat.message` and `lounge.chat.history`. Messages are sanitized, rate-limited, persisted in MongoDB batches, and broadcast with a deterministic rolling room-sentiment score. The keyword scorer is not ML; its 40-message synthetic diagnostic fixture scores 80%, below the PRD's 85% target, and is not blind or representative. See [the API reference](server/API.md) for event payloads and fallbacks.

The Lounge Host can end an active session from Queue after a confirmation prompt. The backend stores its start/end timestamps and an end-time analytics snapshot, then emits `lounge.session.ended` to connected room members. Ended invite codes and queue/chat/Soundclash mutations are rejected. `GET /api/v1/dashboard/lounge-history` returns summary rows only to the Host or previously joined participants, and the Profile page displays those ended sessions. New sessions persist first-socket joins/last-socket leaves and successful AI DJ question counts; legacy sessions without complete event coverage report those metrics as unavailable. Analytics reads reconcile from durable events, and private IDs, invite codes, and question text are not exposed. See [the session analytics contract](server/API.md#dashboard-history-and-lounge-analytics).

The real-time gateway also supports Listener track submissions and votes for a Host-opened Soundclash, server-timed resolution, tie resolution by Host or Co-DJ, and queue insertion at Next Up. Its PRD-defined `.open` and `.resolved` events retain their exact payloads. A deterministic metadata-grounded announcement is used; no AI provider is connected. See [the Soundclash contract](server/API.md#soundclash) for implementation choices where the PRD is silent.

The backend records authenticated listening interactions and serves a private hybrid recommendation rail from acoustic profiles and co-listener reports. Profile shows an authenticated acoustic taste summary from persisted interaction rows; it deduplicates preference weight per track and requires two distinct valid acoustic tracks before showing metrics. `GET /api/v1/recommendations/taste` returns the same user-scoped profile data. Thoughtness and Chill Beat remain unprofiled. The former Ivory Atlas/Faded Fortress audio pair was withdrawn because its licensing/source evidence could not be revalidated; the catalog entries now have no audio or acoustic profile. Starter playlists use other currently verified playable assets where available. Current source and analysis limits are documented in [the fixture analysis](docs/reference/audio-fixture-analysis.md). Interaction records remain app-observed/client-reported, not independent playback telemetry. Recommendations return an empty content cold-start result when no usable profile or qualified collaborative signal exists. The synthetic held-out evaluation scores 0.60 Precision@5 versus a 0.00 popularity baseline across three constructed profiles; this is not an effectiveness claim for real users. Playwright covers normal-speed Ogg history behavior. A real catalog segue is currently unverified because the previously used compatible audio pair has been withdrawn; the runtime performance harness uses synthetic metadata-only tracks in a disposable database. See [the interaction and recommendation contract](server/API.md#recommendations-and-listening-interactions) and [the audio asset notice](public/audio/NOTICE.md).

Lounge members can ask grounded questions about the current track through `POST /api/v1/lounges/:id/ai/ask`. Answers use only the track title/artist, validated acoustic profile, and embedded metadata timeline, with stable source references; unsupported questions return an explicit unavailable answer. Transition banter uses the same stored track facts and acoustic match result, and publishes the PRD-shaped `lounge.ai.dj_announcement` event to that Lounge. These paths use deterministic retrieval/templates and fallback text; no LLM, embeddings, or vector store is configured. See [the AI DJ API contract](server/API.md#grounded-current-track-qa).

## Current UI routes

`/`, `/podcasts`, `/radio`, `/ai-dj`, `/now-playing`, `/search`, `/playlist`, `/queue`, `/artist`, `/profile`, `/album`, and `/settings`. Mobile layouts are responsive states of these routes. Podcasts currently browse NASA's official Curious Universe RSS feed; the feed is read through a fixed-source API endpoint and episode audio is played from the publisher's HTTPS enclosure URL. AstraDJ does not host the podcast files. See [podcast source notes](docs/podcast-sources.md).

## Requirements tracking

See [the PRD compliance matrix](docs/prd-compliance.md) for implementation evidence, verification limits, and remaining requirements. The source PRD is stored at `docs/reference/Internship-PRD.docx`.

## Dashboard history and analytics increment

The authenticated dashboard API exposes the caller's self-reported interaction history, ended Lounge history, and analytics reconciled from persisted lifecycle timestamps, queue/Soundclash events, Lounge metric events, and chat/sentiment records. New sessions have durable peak concurrency and successful AI DJ question counts; legacy sessions without a complete tracking marker return those values as unavailable. The Account/Profile route shows the persisted session summary, including unavailable values instead of misleading zeros. The player uses browser audio only when a track has an `audioAssetUrl`; Thoughtness and Chill Beat are CC0 local assets, while mock selections are never written as listens. See [dashboard API details](server/API.md#dashboard-history-and-lounge-analytics).

For local Vite development, set `VITE_DEV_API_TARGET` if the API is not at the dev default. Production can set `VITE_API_BASE_URL` at build time and the backend `CLIENT_ORIGIN` to the exact frontend origin. Refresh cookies are SameSite=Strict, so the app and API must be same-origin or same-site; no local-only API URL is embedded in the production client bundle.

## Real-browser audio verification

Install the root dependencies and Chrome, create `server/.env.test` from `server/.env.test.example`, and set `MONGODB_TEST_URI` to a local, disposable MongoDB database whose name contains `test`. Run `npm run test:e2e:audio` from the repository root. The runner refuses remote or non-test database targets, creates a uniquely named `astradj_e2e_*` database, seeds it, starts the API and Vite with test-only credentials, then drops only that database after the run. The test registers throwaway accounts through the UI and uses actual Chrome Ogg playback at normal speed; it waits for the real track end, then verifies the authenticated interaction/history and isolation. It requires Chrome and local MongoDB to be available.

To verify the Lounge lifecycle and automatic segue, run `npm run test:e2e:lounge` with the same safe local `.env.test` setup. The first test checks Host/Listener session creation, history and privacy in an isolated database. The second loads the two CC0 MP3s, creates a Lounge with one as Now Playing and the other queued, plays actual media at 10× rate, observes the outro announcement, waits for the real `ended` event, and verifies the next asset begins playing and the queue transition persists in MongoDB. Each run logs one trigger-to-announcement latency sample; two recent runs measured 257.2 and 586.1 ms. These are local observations, not a production P95 guarantee.

To verify audio preference persistence, run `npm run test:e2e:settings` with the same local `.env.test` setup. Playwright registers accounts through the UI, verifies the six saved-only controls are disabled, changes AI DJ commentary, reloads, signs out/in, verifies another account starts with its own defaults, and checks a simulated failed-save response is shown as an error. AI DJ commentary also controls segue-script and Lounge announcement presentation; other audio settings remain stored-only.

To verify catalog screens, run `npm run test:e2e:catalog` with the same safe local `.env.test` setup. It uses the seeded disposable MongoDB catalog to verify Home artists/tracks, catalog-derived Artist tracks, Playlist rows, track selection in the persistent player, and the Album data gap. Separate intercepted responses cover loading, empty and API-error UI states; those states are mocked, not Mongo-backed.

To verify Admin acoustic-profile management, run `npm run test:e2e:admin-acoustic` with the same safe local `.env.test` setup. It creates a disposable MongoDB database and a test-only Admin account, signs in through the UI, edits an unprofiled catalog track, and confirms the values through the public profile endpoint. The Admin API write is separately tested for all-role authorization, strict field/range validation, real Mongo persistence, and use by the segue matcher. Admin-authored profiles are not independently analyzed; the two curated CC0 fixture profiles include provenance for their source, analysis, uncertainty and asset checksums.
