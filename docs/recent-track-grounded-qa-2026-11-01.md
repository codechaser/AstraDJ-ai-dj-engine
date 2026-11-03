# Recent-track grounded AI DJ Q&A — 2026-11-01

## Source of truth and ordering

Recent Lounge playback comes only from persisted `QueueEvent` records with `type: "track.transitioned"`, queried with the already-authorized Lounge's `loungeId`. The Lounge document's `currentTrackId` remains authoritative for the current track. Events are sorted by ascending `seq` to reconstruct edges (`payload.fromTrackId` → `payload.trackId`); the reconstructed tail must equal the authoritative current track or history is treated as unavailable. The current occurrence is removed, then previous occurrences are returned newest first, capped at ten. Repeated plays remain separate occurrences. A repeated row with the same sequence is ignored; discontinuous and malformed edges are ignored. This cannot distinguish a true repeated play from a logically duplicated event written under a new sequence, so repeated edges are retained rather than silently collapsed.

The service reads at most 500 transition events per Lounge request. If the chain cannot be connected to current Now Playing, or a historical catalog row is missing, that evidence is unavailable; the service does not infer playback from queue order or client-supplied history.

## Q&A and references

Current-track factual Q&A retains its existing contract. Recent context supports “what played before this?”, current-versus-previous BPM comparison, questions about the highest recent BPM, and matched authored timeline facts such as producer/sample credits. Highest-BPM questions rank only tracks with BPM metadata; other recent-track questions return matching timeline evidence rather than an unrelated BPM answer. The fallback is deterministic/extractive (`provider: deterministic_metadata_retrieval`); no connected LLM or vector RAG provider is configured.

References reuse stable catalog pointers such as `t_9002#title`, `t_9002#artist`, `t_9002#acoustic.bpm`, and `t_9002#timeline[0]`. Only evidence actually used in the answer is cited. The response additively includes `contextTrackIds` for the recent tracks consulted. Unsupported or missing facts return `grounded: false` and an empty reference list. Conflicting/ambiguous event chains decline instead of selecting an arbitrary track.

Example response from the isolated Mongo integration fixture:

```json
{
  "trackId": "t_9001",
  "answer": "The track before Mongo Current was Mongo Follow-up by Test Artist.",
  "sourceEvents": ["t_9002#title", "t_9002#artist"],
  "grounded": true,
  "provider": "deterministic_metadata_retrieval",
  "contextTrackIds": ["t_9002"]
}
```

## Security and verification

The existing route still requires JWT authentication, Lounge membership, a live Lounge/current track, a valid idempotency key, the existing question validation and the shared rate limit. The client cannot submit history: the request body remains limited to `question`. The event query is restricted to the server-authorized Lounge and catalog lookup uses only IDs reconstructed from that query. No cross-Lounge event is included. AI question analytics remain idempotent and do not store question text.

Unit tests cover sequence ordering, current-occurrence exclusion, repeated plays, duplicate sequence IDs, malformed/discontinuous transitions, empty history, Lounge scoping, previous-track citations, comparison citations, recent BPM ranking, matched timeline retrieval, and current-track regressions. A disposable MongoDB integration test persists A→B→C transition history and verifies the authenticated REST response and source references. The natural-speed Lounge browser E2E asks about the previous track after a real persisted playback transition and verifies the real API response and rendered citation.

Verification on 2026-11-01: focused `metadataRetrieval.test.js` + `segue.test.js` passed 2 suites / 27 tests; `segue.mongo.integration.test.js` passed 1/1 on an isolated database; the natural-speed Lounge E2E passed 1/1 twice during this increment (trigger-to-render Host/Listener samples 685.8/658.7 ms, then 746.8/775.5 ms; these are two single-run observations, not a P95); full backend unit suite passed 20 suites / 164 tests with 13 suites / 18 opt-in tests skipped; root tests passed 25/25; production build passed (1,622 modules); `git diff --check` exited 0. No tests were skipped in the focused runs. The isolated Mongo test uses a generated local test database and drops only that database.

## Remaining limits

- The deterministic parser supports a bounded set of previous/recent/comparison question forms; this is not general natural-language RAG.
- No LLM provider is configured, and no LLM behavior is claimed.
- History is limited to 500 latest returned events and ten previous occurrences.
- Missing catalog rows and broken transition chains are omitted; no backfill is performed.
- A repeated logical event under a new sequence is indistinguishable from an actual repeated play.
- Overall PRD score is unchanged until the full inventory is reconciled.
