# AstraDJ backend setup

This is the Week 1 backend foundation in JavaScript, following PRD Option B: Node.js, Express.js, MongoDB, and Mongoose. The existing Vite frontend remains at the repository root and is not connected to the API yet.

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

Run the backend suite with `npm test`. Jest + Supertest verify the HTTP contract with in-memory repository fakes, while direct Mongoose schema tests validate the document constraints. Live MongoDB integration remains unverified in the current environment.

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
- `GET /health` and `GET /api/v1/health` — API and database state.

Validation errors use `{ "error": { "code", "message", "details" } }`; profile responses use the PRD's `trackId`, `title`, `artist`, `acoustic`, and `timeline` fields.

## Current limits

The authoritative live queue, lounge join/rejoin, Socket.io, chat/presence, Soundclash, sentiment aggregation, deterministic segue selection, grounded AI/RAG, recommendations, analytics, interaction/event persistence, and WebSocket RBAC are not implemented yet. The frontend continues to show the original mock data. See `../docs/prd-compliance.md` for the audit.
