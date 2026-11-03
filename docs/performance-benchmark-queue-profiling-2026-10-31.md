# AstraDJ Queue Performance Profiling and Full Browser Verification

**Report date:** 2026-11-01
**Starting/final HEAD:** `2e74782d074f0ec26c0b380f58184f45c5c0fba7` (`Add Mongo-backed performance benchmark and PRD audit`)
**Scope:** profiling and evidence only. No queue/player/UI behavior was changed in this milestone. The existing runtime benchmark harness received a benchmark-only rate-counter reset between isolated workload batches after a run proved its synthetic sample volume exceeded the configured production quota. Measurements reflect the existing worktree, which already contained uncommitted changes; they do not describe the committed HEAD in isolation.

## PRD targets

The original `docs/reference/Internship-PRD.docx` was inspected. Its §1.3 KPI table defines queue drift as the maximum delay from a queue-mutating event until every client reflects the same state and sets a target of **<100 ms under normal network conditions** (extracted paragraph 42–44). Section 10.2 repeats **<100 ms between clients under good network conditions** (paragraph 325–326), and sets WebSocket fan-out at **<500 ms from server receipt to the last client** for rooms up to design capacity (paragraph 327–328). Section 10.2 also says the architecture should support multiple concurrent rooms (paragraph 329–330). Paragraph locators are used because page numbers were not reliably available from the DOCX extraction.

The browser benchmark's queue acceptance value is a conservative proxy: server command receipt to the same API process receiving the last valid rendered-DOM acknowledgement. Each browser acknowledgement follows React state application, two `requestAnimationFrame` callbacks, DOM revision/track-order checks and a canonical state hash. This includes the acknowledgement return path and is not the exact paint instant. The separate browser receive-to-state and receive-to-DOM durations use `performance.now()` within each page. No client and server monotonic clocks, or clocks from separate API processes, are subtracted.

## Startup investigation

The earlier full-browser attempt reported Chrome `ERR_NETWORK_IO_SUSPENDED` and Vite optimizer `ECONNABORTED`/`ECONNRESET`. Its trace and complete server/browser logs were not preserved, so the exact cause cannot be established retrospectively.

A fresh Tier 3 run did reach readiness with all 50 real browser pages and completed its report. Its captured successful-run output had no matching Vite connection-abort or Chrome network-suspended errors. One page recorded a generic resource 404; the benchmark did not retain the request URL, so that 404 is not attributed to the app. A concurrent 207-sample PowerShell resource monitor observed a peak of **119 Chrome processes**, **6,830.5 MB Chrome process-group RSS**, and only **64.9 MB free system memory** at the low point. The Node process group peaked at 7 processes and **775.9 MB RSS**. This is strong evidence that the successful full run nearly exhausted this laptop's memory, and makes host resource pressure a plausible explanation for the earlier startup errors. It does not prove that memory pressure caused those particular errors.

## Environment and workload

Tier 3 ran `npm run benchmark:multi-room` from `server` with `BENCH_BROWSER_CLIENTS_PER_ROOM=50` and a unique `BENCH_REPORT_PATH`. It completed in **510,059.523 ms** including setup/teardown; the queue workload itself was 3 rooms × 30 seconds at 1 add/second/room. The raw output is [the Tier 3 JSON report](performance-benchmark-queue-profiling-tier3-full-2026-10-31-5a0f6ebec19d43ab9994aca075306d23.json).

| Property | Tier 3 setup |
|---|---|
| OS/runtime | Windows x64; Node v24.22.2; Intel Core i5-8350U 1.70 GHz; 8 logical CPUs |
| Browser | Installed Chrome 156.0.8078.49, headless; 50 isolated visible Chromium pages |
| Frontend/API | Vite development server and 2 independent API processes; not the production bundle/deployment |
| Persistence | MongoDB 8.2.5 standalone, loopback only; generated `astradj_test_*` database was dropped after the report |
| Rooms/participants | 3 rooms × 50 authenticated participants; 152 total socket connections. The measured room used 50 real browser pages; the other rooms used Socket.IO clients. |
| Mutations | 30 add attempts per room at 1 Hz for 30 seconds; no mutation warm-up. Browser contexts were opened sequentially; measurement began after joins/index setup. |
| Network | Local loopback. This does not reproduce a remote or deployed network. |

## Stage profile — Tier 3

The source trace uses `performance.now()` within the API handling each command. Timings below include **accepted server traces only** (`n=68` unless stated). Percentiles use nearest-rank. Stages can be nested or overlap; do not sum their percentiles. `handlerTotalMs` spans the queue handler but excludes the benchmark's browser-render acknowledgement wait.

| API stage | Samples | P50 | P95 | P99 |
|---|---:|---:|---:|---:|
| Rate-limit check | 68 | 24.669 ms | 255.425 ms | 479.215 ms |
| Membership/role lookup | 68 | 28.148 ms | 435.902 ms | 641.873 ms |
| Per-Lounge command serialization wait | 68 | 51.892 ms | 4,868.787 ms | 8,376.672 ms |
| Lounge lookup | 68 | 31.598 ms | 636.115 ms | 3,374.829 ms |
| Host-presence check | 68 | 34.212 ms | 612.051 ms | 2,165.301 ms |
| Mutation track lookup | 68 | 28.434 ms | 1,329.805 ms | 2,496.388 ms |
| Coordination snapshot read | 68 | 27.981 ms | 434.352 ms | 994.925 ms |
| Event validation/build | 68 | 0.065 ms | 0.767 ms | 8.174 ms |
| Mongo outbox size read | 68 | 25.592 ms | 305.160 ms | 763.140 ms |
| Mongo revision CAS | 68 | 61.496 ms | 786.300 ms | 1,155.624 ms |
| Mongo outbox-drain read | 68 | 25.936 ms | 129.007 ms | 627.630 ms |
| QueueEvent upsert | 67 | 26.331 ms | 759.668 ms | 3,505.485 ms |
| Outbox acknowledgement pull | 67 | 34.628 ms | 675.079 ms | 3,082.702 ms |
| Coordination commit + outbox projection | 68 | 275.208 ms | 2,545.446 ms | 4,032.767 ms |
| Response track hydration | 68 | 31.180 ms | 494.087 ms | 1,504.743 ms |
| Queue handler total | 68 | 982.390 ms | 8,383.803 ms | 10,865.576 ms |

The end-to-end measurements were also recorded separately:

| Boundary | Samples | P50 | P95 | P99 | Meaning/limit |
|---|---:|---:|---:|---:|---|
| Benchmark driver action start → command ACK | 68 | 1,908.994 ms | 21,339.553 ms | 25,368.710 ms | Node benchmark clock; includes Playwright `evaluate`/selection/click for browser-originated commands, not a timestamp taken at the user's click handler. |
| API receipt → last Socket.IO receipt ACK | 4 complete | 9,126.853 ms | 12,418.362 ms | 12,418.362 ms | Same API monotonic clock; 26/30 requested mutations did not have a complete all-client receipt acknowledgement. |
| API receipt → last browser render ACK | 3 complete | 9,127.187 ms | 12,419.719 ms | 12,419.719 ms | Same API monotonic clock; only 3/30 met the all-browser complete/hash-valid condition. |
| Browser event receipt → React state application | 500 | 673.000 ms | 1,273.900 ms | 1,841.900 ms | Per-page monotonic timing; available observations only. |
| Browser event receipt → DOM marker after React commit + two frames | 458 | 785.600 ms | 1,516.400 ms | 2,103.000 ms | Per-page monotonic timing; missing observations are not counted as successful renders. |

The current source records server-side broadcast start/end in its volatile trace, but the benchmark's returned per-mutation trace is serialized with the command acknowledgement and does not contain a usable broadcast-emission latency distribution. Therefore **broadcast-call duration and queue-poll-to-broadcast percentiles are unavailable** in this artifact. The benchmark does measure browser receive/state/DOM durations and same-process receipt-to-ack upper bounds. It does not timestamp the revision guard itself. It also has no React Profiler commit counter: the queue event handler calls both `setQueueRenderTraces` and `setQueueState`, and the later command acknowledgement can call `setQueueState` again. Whether these paths produce one or multiple React commits per logical event was **not directly measured**; long-task data alone cannot answer that question.

## Browser rendering and host diagnostics

All 50 pages reported `document.visibilityState === "visible"`. The browser observer recorded **4,785 long tasks**: P50 **156 ms**, P95 **771 ms**, P99 **1,179 ms**, maximum **3,238 ms**; 4,747 exceeded 50 ms, 1,173 exceeded 250 ms, and 108 exceeded 1 second. All pages recorded long tasks. The benchmark's DOM marker was calculated after two animation frames and checked revision, ordered IDs and a state hash. The render-ack round trip is an upper bound, not a direct measure of the instant a user sees pixels.

Across **902 one-second API-process samples** (two process monitors), the distribution of per-second event-loop-delay P95 readings was P50 **27.410 ms**, P95 **310.641 ms**, P99 **1,564.475 ms**, max **4,643.095 ms**. The per-second event-loop utilization distribution was P50 **0.139**, P95 **0.972**, P99/max **1.000**. This supports substantial server scheduling delay during the run. The same high tails in Mongo command timings, serialization wait and browser long tasks show that the degradation is not isolated to the outbox. These measures were collected under severe host memory pressure, so they do not isolate normal-load application capacity.

The source shows `LiveQueuePage.hydrateUpdate` makes a revision check, hydrates missing catalog tracks, then schedules queue-state and trace-state updates. The revision guard rejected no stale revisions in the Tier 3 trace (`skippedRevisionClients=0`), but incomplete client observations and **92 queue-state divergence observations** remain. The benchmark observed **1,000 missing Socket.IO receipts**, **1,042 missing DOM renders**, **342 invalid render acknowledgements**, and **0 duplicate Socket.IO deliveries** across 4,500 expected recipient events. The missing/incomplete samples prevent claiming that all clients converged per event.

## Tier comparison

| Tier | Workload/evidence | Result |
|---|---|---|
| 1 — socket-only | Current `cd server && npm run benchmark:prd`, 1 process, 1 in-memory Lounge, 50 authenticated Socket.IO clients, 20 sequential adds, no MongoDB or browser. | Exit 0; p50/p95/p99 client arrival spread **2.324/2.801/3.073 ms** (n=20); server receipt → last client receipt **4.634/5.348/7.710 ms** (n=20); command ACK RTT **2.768/4.540/5.169 ms** (n=20). This validates the synthetic socket path only and is not queue acceptance evidence. |
| 2 — reduced Mongo + browser diagnostic | Existing before/after runs: 3 rooms × 50 authenticated participants, 2 API processes, 30 additions/room at 1 Hz, local disposable Mongo, 5 real browser pages in measured room and 45 socket clients. | Before/after 5-browser render-ack upper-bound P50/P95/P99 **257.329/395.816/541.877 ms** → **276.971/429.854/463.933 ms** (n=30 each); P95 worsened. Server receipt → last socket client P95 **279.540 → 264.750 ms** (n=30 each). Both runs accepted/persisted 90/90, received 4,500/4,500 socket events, had zero socket duplicates/divergences and ended with zero outbox backlog. This is not 50-browser acceptance. |
| 3 — full browser | Current Tier 3 report: 3×50 participants, 50 real browser pages in measured room, 2 API processes, disposable local Mongo, 30 attempts/room. One successful run. | 30 browser-room mutations requested, 8 acknowledged, 22 command ACK timeouts, 3 complete all-browser render samples and 27 incomplete mutations. All-client queue-sync proxy P95 **12,419.719 ms** on only 3 complete samples; target **failed** and P95 evidence is far too sparse for a stable estimate. Fan-out proxy P95 **12,418.362 ms** on 4 complete samples with incomplete receipt acknowledgements; formally **unverified/incomplete**, with observed values far above 500 ms. |

The Tier 2 before/after reports are one run apiece, not repeatability evidence. Tier 3 was not repeated: its single run left only 64.9 MB free RAM and produced severe long tasks, so another 50-page run on this machine would add stress without establishing a stable result. Thirty requests do not become a meaningful full-capacity P95 when only three observations complete.

## Durable multi-process runtime benchmark attempt

The existing `benchmark:runtime` harness was also attempted against the safe loopback `astradj_test_*` configuration. The first attempt exited 1 at an outbox queue-add with `QUEUE_RATE_LIMITED`: 100 synthetic adds per concurrency level reused a 10-add/user/minute policy. The harness was adjusted to clear only `RateLimitCounter` rows in its unique disposable database between independent batches; normal limiter checks still run for each request, and limiter quota throughput is explicitly excluded. API samples are sent in paired batches of 50 per process (100 total, below the shared local-IP catalog limit of 120/minute); queue counters are reset between levels.

The adjusted rerun progressed through API reads, queue load, outbox observations and segue samples, but exited 1 when the first Soundclash submission received no acknowledgement before the harness timeout (`Soundclash first submission failed: undefined`). The harness currently emits its full JSON only after every phase succeeds, so this failed run left no report artifact and its earlier stage metrics cannot be recovered. Its `finally` path stopped the two API processes and dropped the unique disposable database. The absent acknowledgement is not enough to distinguish server overload, a blocked request, or benchmark orchestration; it is not treated as a Soundclash product regression. Consequently, durable-runtime API/queue/outbox/recovery percentiles from this harness remain unavailable in this milestone. The successful Tier 3 real-browser report and the historical Tier 2 reports remain the available multi-process queue evidence.

## Persistence and correctness reconciliation

Tier 3 reports **68 acknowledged additions**, zero acknowledged additions missing from durable event storage, zero missing durable events, **one duplicate durable event**, and zero pending outbox rows at the end. Each room's final persisted snapshot was observed rendered by all members. The measured room contained 11 persisted add rows with 10 unique correlation IDs; its 8 timely acknowledged adds therefore do not reconcile one-to-one with its persisted row count. The benchmark does not prove that each of the 22 timed-out browser commands failed or succeeded; a missing ACK is not a transaction rollback. At the final snapshot boundary, all rooms converged, but this does not erase the per-mutation delivery gaps or the duplicate row.

## Diagnosis and action

Evidence points to a combination of per-Lounge serialization wait, slow variable Mongo calls (including revision CAS, QueueEvent upsert and outbox pull), response hydration, Node event-loop delay, and browser main-thread scheduling. The 50-page workload nearly exhausted host memory. This fresh full run succeeded at setup, so the earlier Vite/Chrome startup error is not reproducible from preserved artifacts. The data does **not** justify a production queue change: the run is resource-constrained, its request/render samples are incomplete, and the current instrumentation cannot cleanly separate every stage. Queue semantics, auth, event contracts, the Mongo CAS/outbox and the UI were left untouched.

Next: collect broadcast/emit and revision-validation timings, plus React commit counts, with diagnostic-only instrumentation that does not alter the public event contract; run at least 100 complete mutation samples across repeated runs on a host with substantial memory headroom (16 GB is a practical recommendation based on the observed Chrome peak, not a PRD requirement); then repeat on the intended shared-Mongo/load-balanced topology. Keep database-call timing, same-process Socket.IO delivery, browser state application and rendered-DOM bounds separate. Do not accept queue drift until the <100 ms target passes with complete client coverage. Fan-out remains unverified against <500 ms outside this local run.

## Checks run for this milestone

| Command | Result |
|---|---|
| `cd server; npm run benchmark:multi-room` with `BENCH_BROWSER_CLIENTS_PER_ROOM=50` and a unique output path | Exit 0; full Tier 3 run completed and dropped its isolated test database. Acceptance failed as described above. |
| `cd server; npm run benchmark:prd` | Exit 0; Tier 1 socket run completed. The command also printed a sentiment score of 78/90 (86.67%) for the developer-authored synthetic fixture, while the existing compliance documents report 69/90 (76.67%). This milestone did not audit or change that classifier/fixture; treat the discrepancy as unresolved and do not use this queue report to claim sentiment compliance. |
| `npm test` (repository root) | Exit 0; 25 passed, 0 failed, 0 skipped. |
| `cd server; npm test` | Exit 0; 18 suites passed, 13 suites skipped; 152 tests passed, 18 skipped. The optional database-backed tests ran in the integration suite below. |
| `cd server; npm run test:integration` | Exit 0; 31 suites passed, 170 tests passed, 0 skipped against isolated loopback `astradj_test_*` databases. |
| `npm run test:e2e:lounge` | Exit 0; 4/4 Chrome tests passed (2.6 minutes), including chat, Host-create/member-join, accelerated real-media segue, and Soundclash vote/persistence flows. These are functional browser checks, not load acceptance. |
| `npm run build` | Exit 0; Vite 8.3.2 transformed 1,622 modules. |
| `cd server; node --check scripts/runtimePerformanceBenchmark.js` | Exit 0 after the benchmark-only batching change. |
| `cd server; $env:BENCH_RUN_ID='profile-2026-11-01'; npm run benchmark:runtime` | Exit 1 at queue-add with `QUEUE_RATE_LIMITED`; isolated DB cleanup completed. |
| `cd server; $env:BENCH_RUN_ID='profile-rerun-2026-11-01'; npm run benchmark:runtime` | Exit 1 at first Soundclash submission after no acknowledgement; API processes stopped and isolated DB cleanup completed. No full JSON report was written. |
| `git diff --check` | Exit 0 after final documentation edits; no whitespace errors. Git emitted expected LF-to-CRLF working-copy warnings for pre-existing files. |

No Atlas/production database, credentials, or real user data were used. The source worktree was not staged or committed.
