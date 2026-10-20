# AstraDJ

AstraDJ is a reference-led music experience. Its existing React + Vite frontend remains in the repository root. The new API is a separate JavaScript package under `server/`.

## Track and technology stack

**Track A — Full-Stack (Option B / MERN)**, as specified by the internship PRD.

- Client: React + Vite, JavaScript, Tailwind CSS, React Router
- API: Node.js + Express.js
- Database: MongoDB + Mongoose
- Real-time gateway: Socket.io (authenticated Lounge join, shared queue, presence, sync and reconnect)
- Authentication: JWT access token plus rotating refresh cookie
- Tests: Jest + Supertest

The client still uses its existing mock music data. No Spotify infrastructure, accounts, catalog, or user data are used.

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

The frontend is not yet connected to the new API. Most backend HTTP and Socket.io tests use repository fakes. Opt-in segue, chat, and recommendation integration tests use unique temporary MongoDB databases when `MONGODB_TEST_URI` is configured; the normal `server/.env` runtime configuration and deployment are still to be verified.

The backend also exposes an authenticated, Lounge-member-only acoustic segue endpoint at `POST /api/v1/lounges/:id/ai/segue`. It applies BPM/Camelot rules, ranks eligible tracks, and uses a metadata-grounded deterministic fallback until an AI provider is configured. See [the API reference](server/API.md).

Authenticated Lounge members can also use Socket.io `lounge.chat.message` and `lounge.chat.history`. Messages are sanitized, rate-limited, persisted in MongoDB batches, and broadcast with a deterministic rolling room-sentiment score. The keyword scorer is not ML and its accuracy has not been evaluated. See [the API reference](server/API.md) for event payloads and fallbacks.

The real-time gateway also supports Listener track submissions and votes for a Host-opened Soundclash, server-timed resolution, tie resolution by Host or Co-DJ, and queue insertion at Next Up. Its PRD-defined `.open` and `.resolved` events retain their exact payloads. A deterministic metadata-grounded announcement is used; no AI provider is connected. See [the Soundclash contract](server/API.md#soundclash) for implementation choices where the PRD is silent.

The backend records authenticated, explicitly self-reported listening interactions and serves a private hybrid recommendation rail from acoustic profiles and co-listener reports. Playback is not verified by a player; recommendations return an empty cold-start result when no supported history exists. A small synthetic held-out fixture measures Precision@5 at 0.6; this is not an effectiveness claim for real users. See [the interaction and recommendation contract](server/API.md#recommendations-and-listening-interactions).

Lounge members can ask grounded questions about the current track through `POST /api/v1/lounges/:id/ai/ask`. Answers use only the track title/artist, validated acoustic profile, and embedded metadata timeline, with stable source references; unsupported questions return an explicit unavailable answer. Transition banter uses the same stored track facts and acoustic match result, and publishes the PRD-shaped `lounge.ai.dj_announcement` event to that Lounge. These paths use deterministic retrieval/templates and fallback text; no LLM, embeddings, or vector store is configured. See [the AI DJ API contract](server/API.md#grounded-current-track-qa).

## Current UI routes

`/`, `/ai-dj`, `/now-playing`, `/search`, `/playlist`, `/queue`, `/artist`, `/profile`, `/album`, and `/settings`. Mobile layouts are responsive states of these routes.

## Requirements tracking

See [the PRD compliance matrix](docs/prd-compliance.md) for implementation evidence, verification limits, and remaining requirements. The source PRD is stored at `docs/reference/Internship-PRD.docx`.
