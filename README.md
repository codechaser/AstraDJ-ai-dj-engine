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

The frontend is not yet connected to the new API. Backend HTTP and Socket.io tests use repository fakes; direct live-MongoDB integration and deployment configuration are still to be verified.

## Current UI routes

`/`, `/ai-dj`, `/now-playing`, `/search`, `/playlist`, `/queue`, `/artist`, `/profile`, `/album`, and `/settings`. Mobile layouts are responsive states of these routes.

## Requirements tracking

See [the PRD compliance matrix](docs/prd-compliance.md) for implementation evidence, verification limits, and remaining requirements. The source PRD is stored at `docs/reference/Internship-PRD.docx`.
