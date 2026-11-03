> **Release evidence correction (2026-11-03):** The segue samples below used the Ivory Atlas / Faded Fortress fixture, whose media and licensing/source claims have since been withdrawn. Preserve these numbers as historical benchmark output only; they do not establish current catalog playback or segue readiness. The runtime harness now uses synthetic metadata-only tracks in its disposable database for segue timing.

# AstraDJ runtime benchmark diagnostics — 2026-11-01

## Scope and preservation

This diagnostic continues from HEAD `2e74782d074f0ec26c0b380f58184f45c5c0fba7` (`Add Mongo-backed performance benchmark and PRD audit`). HEAD did not change. The worktree was already dirty at start; the benchmark manifest records the pre-run worktree entry count. No existing changes were reset, staged, committed, or deleted. `index.html` remained modified and unchanged during the benchmark; the final complete run recorded SHA-256 `6f039e9d735547f95bbc38631ab9d4ceda28e007ce0beb6d32bd48fee753d1ee` at both start and end. `server/.env.example` was preserved.

The previous 50-browser stress workload was not repeated. Earlier evidence showed about 6.83 GB Chrome RSS and only about 65 MB free physical memory at its peak. This machine has 7.88 GiB RAM and 8 logical CPUs; the runtime diagnostic started with about 1.6 GiB free, so it used 51 Socket.IO clients across two API processes and did not launch Chromium stress.

## Benchmark implementation

`server/scripts/runtimePerformanceBenchmark.js` now creates a unique run directory and manifest before connecting. It writes a stage record as each stage starts and finishes, preserving completed results if later work fails. Writes use a temporary file, flush, and no-overwrite hard link. Errors and log output are sanitized; manifests record only loopback host and safe database namespace, never a URI or credential. Every database-backed run requires a loopback `MONGODB_TEST_URI`, creates a unique `astradj_test_*` database and drops only that generated database through the guarded test helper.

The benchmark starts two independent API processes, authenticates 51 Socket.IO client connections (Host sockets on both processes, plus Co-DJ and Listener accounts), and exercises the catalog, queue, outbox, segue, Soundclash, and restart paths. Normal authorization and rate limits remain active; only counters inside the unique disposable database are cleared between independently measured batches. API response latency is end-to-end loopback HTTP latency; `Server-Timing` supplies app-path duration. Database query spans are not separately instrumented. Queue drift is the spread between first and last of the 51 in-memory Socket.IO client callbacks for a mutation; it is not DOM rendering. Percentiles use nearest rank. The outbox milestone values use 1 ms polling and are upper bounds that include polling/query time.

Runtime for the two complete runs: Windows x64, Node v24.22.2, Intel Core i5-8350U, 8 logical CPUs, 7.88 GiB RAM, MongoDB 8.2.5 standalone on loopback. Each complete run took about 73 seconds. Two processes were used. API concurrency was 1/10/25 per process, 500 measured requests per process per level (1,000 aggregate) and 25 warm-up requests per process. Queue concurrency was 1/5/10/20 with 100 successful mutation attempts per level and 51 clients. There were 10 outbox observations, 20 segue decisions, 20 Soundclash votes, and a 25-client gateway restart/rejoin check. The two complete runs are useful local repeatability evidence, not a production-scale sample.

Raw stage reports are preserved separately:

- [`runtime-mvxaa4s4-e12935dd`](runtime-benchmark-runs/runtime-mvxaa4s4-e12935dd/) — partial report; all functional stages completed, cleanup status recording failed.
- [`runtime-mvxae1y6-293be5ab`](runtime-benchmark-runs/runtime-mvxae1y6-293be5ab/) — complete.
- [`runtime-mvxau1gp-fbd72678`](runtime-benchmark-runs/runtime-mvxau1gp-fbd72678/) — complete; includes the corrected repeated-track/final-state reconciliation and SHA-256 preservation check.

## Soundclash timeout investigation

The old reported timeout is not reproduced, but its exact root cause remains unresolved. Inspection of the committed benchmark at starting HEAD shows that it already submitted `lounge.soundclash.submit` with `{ trackId }` from a joined Listener socket, matching the event/payload/role shape in the passing Playwright flow. It used synthetic, test-database Track documents, while Playwright uses the two seeded CC0 catalog candidates; that fixture difference reduces test fidelity but is not evidence that it caused the timeout. The earlier attempt had no per-stage journal or post-timeout persisted-state inspection, so it cannot distinguish a request that never arrived from an acknowledgement lost after persistence. A missing acknowledgement alone is not evidence of rejection or data loss.

The current benchmark was compared with the Lounge Playwright flow and now uses the server contract `lounge.soundclash.submit` with `{ trackId }`, an authenticated, joined Listener, and genuine catalog candidates. Its opt-in random correlation ID is sanitized and follows request receipt, limiter, authentication/membership, payload validation, Host-presence check, service, persistence/broadcast, and acknowledgement callback. It records post-ack state, pending outbox count, projected `QueueEvent`, Host/other-client receipts, and process health. Neither report includes tokens, payload text, or personal account identifiers.

In both complete runs, first and second submissions returned successful acknowledgements, committed the collecting/open battle snapshot, projected one event per submission, had no pending outbox entries, reached the Host on both processes, and were seen by another Listener. Trace order reached `ack_ready` and `ack_callback_invoked`. The second submission opened the battle. Run 3 acknowledgement latencies were 70.675 ms and 103.596 ms. The Lounge E2E suite also passed its persisted two-Listener auto-open/vote-total scenario. These runs make a current production defect less likely, but do not reconstruct the old timed-out attempt; the original timeout is therefore **unresolved / not reproduced**, not declared a harness-only or product defect.

Run 1 completed all 14 functional stages, including both Soundclash submissions, voting, resolution, and restart recovery, but reported a cleanup failure because the then-current shutdown waiter did not observe a process exit promptly. Both child processes exited; the run's database was later dropped manually using the loopback and generated-namespace guards. This partial report is retained unchanged. The process-stop wait was corrected before runs 2 and 3; both then recorded all 15/15 stages complete, zero failed/timed-out/skipped stages, clean process shutdown, and successful isolated database drop.

## API latency

Catalog request `GET /api/v1/tracks?limit=10`, with normal authentication-independent catalog access and production rate limiting enabled. Each cell has 1,000 aggregate response samples per run; nearest-rank percentiles.

| Per-process concurrency | Run 2 P50 / P95 / P99 (ms) | Run 3 P50 / P95 / P99 (ms) | Errors / timeouts per run | PRD §10.2 target <200 ms P95 |
|---:|---:|---:|---:|---|
| 1 | 7.079 / 11.658 / 14.806 | 6.970 / 9.733 / 12.036 | 0 / 0 | Met in this local catalog sample |
| 10 | 34.452 / 48.651 / 58.828 | 38.462 / 54.079 / 62.203 | 0 / 0 | Met in this local catalog sample |
| 25 | 83.204 / 103.436 / 116.883 | 93.849 / 115.499 / 123.184 | 0 / 0 | Met in this local catalog sample |

Run 3 `Server-Timing` app-path P95 was 7.292, 40.616 and 91.528 ms at concurrency 1, 10 and 25. Mongo subquery timing is unavailable, so no database-only bottleneck is asserted. The API target is met for this one endpoint and local environment only; other APIs and production networking remain unmeasured.

## Queue, outbox, and fan-out observations

Each queue concurrency level completed 100/100 mutations in each run (0 acknowledgement errors). Each run's 400 successful adds were reconciled to 400 projected `track.added` rows; across the two runs that is 800 adds and 800 projected rows. Duplicate logical events, successful additions missing from the durable event log, additions missing from the persisted queue snapshot at the queue-load reconciliation point, client event omissions after the 18-second deadline, and final outbox backlog were all zero. All 51 clients resynchronized to the expected revision. Queue percentiles use 100 samples per level per run.

| Concurrent queue commands | Run 2 drift P50 / P95 / P99 / max (ms) | Run 3 drift P50 / P95 / P99 / max (ms) | Run 2 / Run 3 ack P95 (ms) |
|---:|---:|---:|---:|
| 1 | 17.478 / 34.070 / 53.286 / 56.987 | 16.914 / 19.357 / 31.539 / 33.731 | 31.029 / 23.177 |
| 5 | 17.857 / 42.141 / 79.558 / 97.736 | 22.363 / 42.596 / 53.428 / 64.469 | 125.126 / 99.019 |
| 10 | 32.789 / 68.560 / 70.072 / 74.954 | 33.126 / 50.074 / 57.264 / 58.534 | 295.533 / 226.090 |
| 20 | 42.323 / 68.706 / 85.310 / 105.631 | 44.723 / 84.902 / 107.187 / 110.321 | 534.893 / 500.297 |

Both runs' queue-client drift P95 samples are below the PRD §1.3/§10.2 <100 ms value, including concurrency 20. This is a 51-socket, two-process local callback-spread proxy with only 100 samples at each load, not browser DOM rendering or deployment evidence. One run's P99 at concurrency 20 exceeded 100 ms; there is run-to-run spread. Do not mark broad queue synchronization compliance complete from this reduced workload.

The benchmark separately records sender-command-start to last client event callback as an **upper-bound proxy**. At concurrency 20 its P95 was 576.655 ms (run 2) and 538.071 ms (run 3). This interval includes client command and server work before the broadcast, so it is not the PRD §10.2 interval from server receipt to final recipient. The exact WebSocket fan-out target is **unverified**, not a confirmed miss based on these values.

The ten-run outbox probes do not identify a dominant stage: run 2 P95 ack/commit-observed/projection-after-commit/drain-after-projection was 125.241/77.486/10.081/22.670 ms; run 3 was 58.907/55.106/17.852/21.298 ms. These are polling-based upper bounds, with too few samples to attribute the high-concurrency queue timing or justify an outbox change. The benchmark does not expose every internal Mongo stage at queue concurrency. No speculative production optimization was made for this milestone.

## Segue, Soundclash, and recovery

The historical segue fixture used the two tracks whose media/licensing evidence has since been withdrawn. Its service timings remain a record of that historical run, not a current catalog or browser playback result.

This does **not** measure actual audio outro entry through rendered browser announcement: the harness supplies `currentTs` and sends `lounge.playback.ended` directly. The PRD <3 s P95 acceptance boundary in §1.3/§10.2 remains **unverified**. Twenty samples are diagnostic and do not establish a reliable tail estimate. The separate Lounge browser E2E below is functional behavior evidence only and used 4× playback acceleration.

Soundclash run 3 accepted 20/20 concurrent unique votes, persisted exactly 20 vote events from 20 users, produced the tie event at the stored deadline, and resolved to one persisted event/status. Vote acknowledgement P95 was 641.934 ms. Gateway restart recovery succeeded with 25 clients rejoining and state revision 494 restored; duration was 4.656 s in run 2 and 8.787 s in run 3. Full final lifecycle reconciliation found 494 QueueEvents, 20 `track.transitioned`, Soundclash events 2 submitted / 1 opened / 20 voted / 1 tied / 1 resolved, `resolved` battle state, and empty outbox. The 429 add-event rows include later re-enqueues of the verified segue pair; 17 repeated pair rows were expected lifecycle additions, not duplicate delivery. Queue-load stage reconciliation separately confirmed all 400 additions before later playback lifecycle changes.

## Verification performed in this milestone

| Command | Result |
|---|---|
| `cd server; npm test -- --runInBand` | Exit 0; 20 suites passed, 13 skipped; 158 passed, 18 skipped. |
| `cd server; npm run test:integration` | Exit 0; 33 suites and 176 tests passed, 0 skipped. |
| `npm test` | Exit 0; 25 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:lounge` | Exit 0; 4/4 Chrome tests passed, including Lounge chat, Host/invite join, accelerated-media natural-ended segue, and persisted Soundclash open/voting. |
| `cd server; npm run benchmark:runtime` | Initial journaled run exit 1 because cleanup failed to observe a child exit; all 14 workload stages completed and the database was later dropped with the guard. Two corrected runs exited 0 with all 15 stages complete. Each run used a unique loopback `astradj_test_*` database. |

The full 50-browser stress scenario was not run. No external/Atlas database was accessed. No report claims actual unaccelerated browser latency or a browser render P95.

## PRD status and next work

- **Non-AI API P95 <200 ms:** met for local catalog GET at the tested request rates; other API routes and production are unverified.
- **Queue drift <100 ms:** reduced 51-client local callback-spread samples were below target at P95, but are not browser rendered-state or deployment evidence; target remains partial/unverified for acceptance.
- **WebSocket fan-out <500 ms from server receipt to last client:** unverified at the exact required interval. The available start-to-last-client proxy exceeds 500 ms at concurrency 20.
- **Segue P95 <3 s from actual outro entry through rendered decision/script:** unverified at the specified boundary.
- **Soundclash:** submission, auto-open, vote persistence, tie/resolution, multi-process broadcast, restart recovery passed these local checks. The earlier isolated ack timeout remains unexplained and not reproduced.
- **Overall PRD score:** remains 70.24%; this milestone did not reconcile or rescore the 169-row requirement inventory.

Next priority: instrument and reproduce the full-capacity 50-browser queue event/render path on a host with substantially more free RAM, correlating browser render acknowledgements with durable event rows and persisted revision. Independently capture server-receipt-to-last-recipient timing and natural-speed real-audio outro-to-rendered-announcement timing. Do not tune against the reduced local proxy or claim acceptance until those exact boundaries are measured with adequate samples.
