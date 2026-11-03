# Render deployment

AstraDJ is deployed as one Render Node web service rooted at the repository root. The service builds the Vite frontend and serves it from Express, with REST and Socket.IO on the same HTTPS origin. This is required for the credentialed refresh cookie (`SameSite=Strict`) and keeps browser requests same-origin.

The repository includes `render.yaml` with these settings:

- Root directory: repository root.
- Build command: `npm ci && npm run build && npm --prefix server ci`.
- Start command: `npm --prefix server start`.
- Health check: `/health`.
- Node.js: `22.23.4`, pinned in `.node-version` and the Blueprint environment.
- The Render-assigned `PORT` is used; the server binds `0.0.0.0`.

## Required Render environment

Set these in Render's environment settings. Do not copy a local `.env` file.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` (set by `render.yaml`) |
| `NODE_VERSION` | `22.23.4` (set by `render.yaml`) |
| `MONGODB_URI` | MongoDB Atlas URI for a dedicated production database and least-privilege user |
| `JWT_ACCESS_SECRET` | Render-generated secret from the Blueprint; keep it private and rotate it using the deployment environment controls |
| `CLIENT_ORIGIN` | The exact public service origin, e.g. `https://<your-render-service>.onrender.com` with no path or trailing slash; it must use HTTPS |
| `PORT` | Assigned by Render; do not set a fixed value |

`CLIENT_ORIGIN` is required and validated at startup in production. Use the same public origin for the page, `/api/v1`, `/health`, and `/socket.io`. Do not set `VITE_API_BASE_URL` for this deployment: the frontend defaults to same-origin `/api/v1`, and Socket.IO uses the same origin. `VITE_DEV_API_TARGET` only configures Vite's local development proxy and is not included in the production bundle.

Optional server variables retain their application defaults: `JWT_ACCESS_TTL_SECONDS` (900), `JWT_REFRESH_TTL_DAYS` (7), and `AI_DJ_OUTRO_WINDOW_SECONDS` (12). `AUDIO_ASSET_ALLOWED_HOSTS` can remain empty for the local assets copied from `public/` into `dist/`.

Razorpay is disabled by default. `render.yaml` explicitly sets `RAZORPAY_CHECKOUT_ENABLED=false`; leave it false unless a production merchant, live credentials, plan IDs, webhook endpoint and signature verification have all been configured and reviewed. Never put payment secrets in the Blueprint file.

## Runtime behavior and checks

- MongoDB connection is established before the HTTP server starts accepting traffic. `/health` is registered before the SPA fallback and reports the current Mongoose connection state.
- Refresh cookies remain HttpOnly, Secure in production, scoped to `/api/v1/auth`, and `SameSite=Strict`.
- API routes and `/health` are registered before static hosting. Unknown `/api/...` paths keep the JSON API 404; `/socket.io/...` is excluded from static and SPA handling. Other browser GET routes fall back to `dist/index.html` only when the request accepts HTML.
- Vite copies `public/audio/` and `public/assets/` into `dist/`; Express serves them with the same origin as the application.
- Application startup does not run the track-catalog seed. `ensureDefaultPlans` only maintains the billing plan records; it is not the catalog seed. The explicit `npm run seed` command is for intentional catalog initialization and must not be added to Render's start command.
- SIGINT/SIGTERM closes Lounge timers, flushes pending queue/chat work, closes Socket.IO and disconnects Mongoose.

After creating the Render service from the Blueprint, enter the real Atlas URI and copy the assigned public HTTPS origin into `CLIENT_ORIGIN`. Then deploy and verify `/health`, a direct refresh on `/now-playing`, `/profile`, `/podcasts` and `/radio`, sign-in plus refresh-cookie behavior, audio/artwork requests, and a two-client Lounge session. No live Render deployment or production Atlas connection is claimed by this repository configuration.
