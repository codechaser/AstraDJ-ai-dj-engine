# AstraDJ

AstraDJ is a reference-led music experience prototype. Its current implementation is a React + Vite frontend with mock content.

## Project track and stack

**Track A — Full-Stack (Option B / MERN)** is the selected project direction, per the internship alignment instructions.

Planned stack:

- React + Vite, JavaScript, Tailwind CSS, React Router
- Node.js + Express.js
- MongoDB + Mongoose
- Socket.io + socket.io-client
- JWT authentication
- Jest + Supertest for backend tests

Current state: only the frontend toolchain is implemented. The Express/MongoDB/Socket.io/authentication layers and backend tests are not present yet. Do not interpret this README stack declaration as evidence those features already work.

## Current frontend setup

Requirements: Node.js and npm.

```sh
npm install
npm run dev
```

Create a production bundle with `npm run build`.

The UI uses mock music/artist/playlist data and remote Unsplash artwork / Google Fonts. It does not connect to Spotify or another music catalog.

## Routes currently present

`/`, `/ai-dj`, `/now-playing`, `/search`, `/playlist`, `/queue`, `/artist`, `/profile`, `/album`, and `/settings`.

Mobile layouts are responsive states of these routes, not separate routes.

## Audit

See [PRD compliance matrix](docs/prd-compliance.md) for implementation evidence, gaps, and verification status. The 21-page PRD file was not present in the project or the supplied attachment; the audit uses the pasted alignment instructions as the available requirements summary. Confirm detailed page-specific API parameters against the source PRD before claiming exact contract compliance.
