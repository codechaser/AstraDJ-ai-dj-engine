# AstraDJ deployment checklist

This repository has no hosting-provider configuration yet. Use a provider that can host a Vite static site and a long-running Node.js service, or put both behind a same-origin reverse proxy. The same-origin setup is the simplest option because the app uses credentialed refresh cookies and Socket.IO.

## Frontend

- Build command: `npm ci && npm run build`
- Publish directory: `dist`
- Configure the static host to serve `index.html` for unknown paths so React Router routes such as `/now-playing`, `/profile`, and `/podcasts` survive refreshes.
- Prefer same-origin `/api/v1` and `/socket.io` proxying to the API. If using a separate API hostname, set the build-time `VITE_API_BASE_URL` to `https://<api-host>/api/v1`; the Socket.IO client uses that URL's origin.
- Serve `public/` assets from the frontend origin. Catalog audio and artwork use local `/audio/...` and `/assets/...` paths.

## API service

- Working directory: `server`
- Install command: `npm ci`
- Start command: `npm start`
- Health check: `/health`
- Set `NODE_ENV=production`, the host-provided `PORT`, `MONGODB_URI`, a newly generated `JWT_ACCESS_SECRET` with at least 32 characters, and `CLIENT_ORIGIN` to the exact HTTPS frontend origin.
- Keep the frontend and API same-origin or on sibling HTTPS subdomains. The refresh cookie is `SameSite=Strict`; cross-site hosting will break refresh authentication.
- If deploying behind a proxy, configure WebSocket upgrades for `/socket.io`. Validate HTTP, authentication refresh, catalog audio, and a two-client Lounge flow before opening traffic.
- Start with one API instance. Do not scale horizontally until the target platform's Socket.IO routing and cross-instance delivery behavior have been verified with the multi-process tests; shared MongoDB state alone does not prove Socket.IO clients on different processes receive each other's broadcasts.

## Database and credentials

- Create a dedicated production database and least-privilege MongoDB user. Restrict network access to the hosting provider where possible.
- Provide secrets through the hosting provider's secret/environment settings. Never upload `.env`, `.env.test`, database credentials, JWT secrets, or payment secrets to GitHub.
- `server/.env.example` is a template only. Replace its placeholders locally; do not deploy those literal values.
- Do not run `npm run seed` automatically on every service start. Review seed behavior and run it once only when intentionally initializing a new, empty AstraDJ database.
- Configure Razorpay live credentials and enable checkout only after the production merchant account, webhook URL/signature, plan IDs, and payment lifecycle have been verified. Otherwise leave billing unconfigured.

## Before publishing

1. Review `git status` and every staged file; make a focused commit and exclude local configuration, generated reports/artifacts, and any unrelated work.
2. Set up the GitHub Actions CI check in `.github/workflows/ci.yml`; MongoDB integration and browser suites need separately provisioned disposable test services and are not represented by the unit CI job.
3. Configure the chosen hosting provider and production secrets without copying local `.env` files.
4. Deploy a preview first. Check `/health`, login/refresh, browser console/network errors, direct route refresh, audio asset playback, and two-client Lounge behavior.
5. Confirm backup/restore and rollback procedures before production use.

This checklist is provider-neutral. The app has not been deployed or production-validated by this repository change.
