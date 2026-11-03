# Distributed rate-limit policy

## Enforcement

Application-wide throttles use MongoDB fixed-window counters. Each counter is keyed by a SHA-256 digest of its scope and trusted identity, incremented atomically, and removed after its expiry by a MongoDB TTL index. Every application process uses the same collection. If MongoDB cannot enforce a limit, the operation fails with `503 RATE_LIMIT_UNAVAILABLE`; sensitive operations are never silently allowed without a counter. A rejected operation returns `429` and a `Retry-After` value in seconds.

IP-based limits use Express's `req.ip` or the Socket.IO handshake address. The application does not trust forwarded IP headers by default. Deployments behind a proxy must configure Express's trusted proxy boundary before relying on client IP attribution; trusting arbitrary forwarded headers would allow clients to evade or poison IP limits.

Windows are fixed, not rolling. A client can make a burst across a window boundary. Limits reduce repeated abuse but do not prevent distributed attacks from many IPs or accounts.

## Limits

| Operation | Identity and scope | Limit | Rationale |
|---|---|---:|---|
| Account registration | Source IP | 10 / hour | Bounds automated account creation without sharing account state between unrelated users. |
| Login attempts | Source IP | 20 / 15 minutes | Slows repeated credential guesses; does not permanently lock an account. |
| Refresh-token rotation | Source IP | 60 / 15 minutes | Allows normal session refresh while bounding token-rotation abuse. |
| Socket.IO authentication handshake | Source IP | 120 / minute | Bounds repeated socket setup and JWT/database verification. |
| Lounge join attempts | Authenticated user | 20 / minute | Bounds invite probing and repeated admission work. |
| Chat submissions | Authenticated user + Lounge | 5 / 10 seconds | Preserves the existing chat threshold. A matching persisted `clientMessageId` retry is checked first and does not consume quota. |
| Queue additions | Authenticated user + Lounge | 10 / minute | Prevents queue flooding while allowing active curation. |
| Queue votes | Authenticated user + Lounge | 60 / minute | Allows rapid voting without unbounded update load. |
| Soundclash submissions | Authenticated user + Lounge | 5 / minute | Bounds repeated candidate submissions. |
| Soundclash open/resolve/session end | Authenticated user + Lounge | 3 / minute (session end: 2 / minute) | These are Host-only state transitions; this accommodates retries while limiting repeated mutations. |
| Soundclash votes | Authenticated user + Lounge | 20 / minute | Supports active voting while constraining write amplification. |
| Playback preparation/completion/cancel | Authenticated user + Lounge | 10 / minute | Bounds repeated lifecycle writes without limiting normal track transitions. |
| Lounge synchronization requests | Authenticated user + Lounge | 60 / minute | Bounds repeated snapshot reads while permitting normal reconnection. |
| Lounge creation | Authenticated user | 5 / hour | Bounds resource creation. |
| AI segue requests | Authenticated user + Lounge | 10 / minute | Bounds repeated recommendation/segue work. |
| AI DJ questions | Authenticated user + Lounge | 10 / minute | Preserves the existing question threshold, now shared across processes. |
| Interaction writes | Authenticated user | 60 / minute | Bounds client-reported history write volume. |
| Recommendation reads | Authenticated user | 30 / minute | Bounds repeated recommendation computation. |
| Acoustic taste reads | Authenticated user | 30 / minute | Bounds repeated profile recomputation from listening history. |
| Preference writes | Authenticated user | 30 / minute | Protects account settings writes while allowing ordinary edits. |
| Admin catalog writes | Authenticated user | 30 / minute | Bounds privileged track/profile mutations. |
| Public catalog reads | Source IP | 120 / minute | Bounds unauthenticated catalog scraping and query load. |

## Protected API and Socket.IO surfaces

| Surface | Enforced policy |
|---|---|
| `POST /api/v1/auth/register`, `/login`, `/refresh` | IP policies shown above |
| `PATCH /api/v1/auth/me/preferences` | Authenticated user, 30 / minute |
| `POST /api/v1/lounges` | Authenticated user, 5 / hour |
| `POST /api/v1/lounges/:id/ai/segue`, `/ai/ask` | Authenticated user; Q&A is scoped to user + Lounge, 10 / minute |
| `POST /api/v1/interactions` | Authenticated user, 60 / minute |
| `GET /api/v1/recommendations`, `/recommendations/taste` | Authenticated user, 30 / minute each |
| `GET /api/v1/tracks`, `/tracks/:trackId/acoustic-profile` | Source IP, 120 / minute |
| `POST /api/v1/tracks`, `PUT /api/v1/tracks/:trackId/acoustic-profile` | Authenticated Admin account, 30 / minute |
| Socket.IO connection handshake and `lounge.join` | Source IP (120 / minute) and authenticated user (20 / minute), respectively |
| `lounge.chat.message` and `lounge.chat.history` | Authenticated user + server-joined Lounge; 5 / 10 seconds and 60 / minute |
| `lounge.queue.add`, `lounge.queue.vote` | Authenticated user + server-joined Lounge; 10 / minute and 60 / minute |
| `lounge.soundclash.submit`, `.open`, `.vote`, `.resolve` | Authenticated user + server-joined Lounge; 5, 3, 20, and 3 / minute |
| Playback preparation, completion, cancellation; sync request/ping; session end | Authenticated user + server-joined Lounge; 10 / minute, 60 / minute, and 2 / minute |

Health checks, logout, ordinary authenticated profile/history reads, and static assets are not throttled by this policy. Membership, authorization, schema validation, and idempotency checks remain independent requirements; rate limiting does not grant access.

## Error behavior

HTTP denials retain the standard `{ error: { code, message, details } }` envelope and set `Retry-After`. Socket denials retain the `{ ok: false, error }` acknowledgement and include the stable error code plus `retryAfterSeconds` when available. Rate-store errors fail closed with `503 RATE_LIMIT_UNAVAILABLE`. Mongo TTL cleanup is asynchronous, so an expired record may remain stored briefly; requests select only the current fixed-window key and are not blocked by stale records.
