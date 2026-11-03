import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { io as createClient } from 'socket.io-client';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from '../tests/mongoTestDatabase.js';
import { User } from '../src/models/User.js';
import { Track } from '../src/models/Track.js';
import { DJLounge } from '../src/models/DJLounge.js';
import { QueueEvent } from '../src/models/QueueEvent.js';
import { RateLimitCounter } from '../src/models/RateLimitCounter.js';
import { seedTracks } from '../src/seed/tracks.js';
import { createRuntimeBenchmarkJournal, summarizeBenchmarkError } from './runtimeBenchmarkJournal.js';

const configuredUri = process.env.MONGODB_TEST_URI;
const apiSamples = numberSetting('BENCH_API_SAMPLES', 500, 100, 5000);
const queueSamplesPerLevel = numberSetting('BENCH_QUEUE_SAMPLES_PER_LEVEL', 100, 10, 500);
const queueConcurrencyLevels = [1, 5, 10, 20];
const apiConcurrencyLevels = [1, 10, 25];
const soundclashVoteCount = 20;
const segueSamples = 20;
const warmupSamples = 25;
const benchmarkSecret = crypto.randomBytes(48).toString('hex');
const requestedRunId = process.env.BENCH_RUN_ID ?? 'runtime';
if (!/^[a-z0-9-]{1,24}$/.test(requestedRunId)) throw new Error('BENCH_RUN_ID may contain lowercase letters, digits, and hyphens only');
const benchmarkRunId = `${requestedRunId.slice(0, 12)}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
const syntheticSegueTrackIds = ['t_perf_segue_current', 't_perf_segue_next'];
const soundclashTrackIds = ['t_cc0_thoughtness', 't_cc0_chill_beat'];
const plannedStages = [
  'database_guard_and_connect', 'seed_fixture', 'start_api_processes', 'connect_and_join_clients',
  'api_catalog_reads', 'segue_measurement', 'queue_mutations', 'outbox_stage_observations',
  'soundclash_submit_first', 'soundclash_submit_second', 'soundclash_vote_wave',
  'soundclash_resolution', 'gateway_restart_recovery', 'final_reconciliation', 'cleanup',
];
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const entryPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function numberSetting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function assertSafeTestMongoUri(value) {
  if (!value) throw new Error('MONGODB_TEST_URI is required; use the local isolated-test configuration');
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('?')[0]);
  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || !database.startsWith('astradj_test_')) {
    throw new Error('Refusing to benchmark: MONGODB_TEST_URI must point to loopback and an astradj_test_* database');
  }
  return { hostname: url.hostname, configuredDatabasePrefix: 'astradj_test_*' };
}

function describeConfiguredMongoTarget(value) {
  if (!value) return { configured: false, parseable: false };
  try {
    const url = new URL(value);
    return {
      configured: true,
      parseable: true,
      protocol: url.protocol,
      hostname: url.hostname,
      database: decodeURIComponent(url.pathname).split('/').filter(Boolean)[0] ?? '',
      loopback: ['127.0.0.1', 'localhost', '::1'].includes(url.hostname),
    };
  } catch {
    return { configured: true, parseable: false };
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)].toFixed(3));
}

function summarize(values) {
  if (!values.length) return { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

function makeQueueBenchmarkTrack(trackId) {
  return {
    trackId, title: `Queue workload ${trackId}`, artist: 'AstraDJ isolated queue benchmark', durationSeconds: 180,
    audioAssetUrl: null, acoustic: null, timeline: [],
  };
}

function makeSyntheticSegueTrack(trackId, bpm) {
  return {
    trackId, title: `Synthetic segue fixture ${trackId}`, artist: 'AstraDJ isolated benchmark', durationSeconds: 180,
    audioAssetUrl: null, acoustic: { bpm, camelotKey: '8A', energy: 0.5, valence: 0.5 },
    acousticEvidence: { fixtureOnly: true, note: 'Synthetic benchmark metadata; not a playable/licensed catalog recording.' }, timeline: [],
  };
}

function benchmarkCorrelationId(loungeId, trackId) {
  return crypto.createHash('sha256').update(`${loungeId}\0${trackId}`).digest('hex').slice(0, 24);
}

function makeToken(userId) {
  return jwt.sign({}, benchmarkSecret, {
    subject: String(userId), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 3600, algorithm: 'HS256',
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sanitizedOutput(text, mongoUri) {
  return text.replaceAll(mongoUri, '[isolated Mongo URI]').replaceAll(benchmarkSecret, '[benchmark JWT secret]');
}

async function startApiProcess(port, mongoUri) {
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: 'test',
    PORT: String(port),
    MONGODB_URI: mongoUri,
    JWT_ACCESS_SECRET: benchmarkSecret,
    JWT_ACCESS_TTL_SECONDS: '3600',
    JWT_REFRESH_TTL_DAYS: '7',
    AI_DJ_OUTRO_WINDOW_SECONDS: '12',
    ASTRA_RUNTIME_BENCH_DIAGNOSTICS: 'true',
  };
  const child = spawn(process.execPath, [entryPath], { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let logBuffer = '';
  const runtimeRecords = [];
  const collectOutput = (data) => {
    const text = data.toString();
    output = (output + text).slice(-5000);
    logBuffer += text;
    const lines = logBuffer.split(/\r?\n/);
    logBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.includes('astradj.runtime.')) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.type === 'string' && parsed.type.startsWith('astradj.runtime.')) runtimeRecords.push(parsed);
      } catch { /* Ignore unrelated or partial child output. */ }
    }
    if (runtimeRecords.length > 2000) runtimeRecords.splice(0, runtimeRecords.length - 2000);
  };
  child.stdout.on('data', collectOutput);
  child.stderr.on('data', collectOutput);
  const origin = `http://127.0.0.1:${port}`;
  const startupStarted = performance.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API process exited during startup: ${sanitizedOutput(output, mongoUri)}`);
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return {
        child, origin, port,
        startupMs: Number((performance.now() - startupStarted).toFixed(3)),
        getRuntimeDiagnostics(correlationId, type = 'astradj.runtime.soundclash') {
          return runtimeRecords.filter((record) => record.type === type && record.correlationId === correlationId);
        },
        getRuntimeRecords(type) { return runtimeRecords.filter((record) => record.type === type); },
        getOutputTail() { return sanitizedOutput(output, mongoUri).slice(-2500); },
      };
    } catch { /* The server has not bound yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`API process did not become healthy: ${sanitizedOutput(output, mongoUri)}`);
}

async function stopApiProcess(processInfo) {
  if (!processInfo?.child) return { stopped: false, reason: 'missing-process-handle' };
  const child = processInfo.child;
  if (child.exitCode !== null || child.signalCode !== null) return { stopped: true, exitCode: child.exitCode, signalCode: child.signalCode, alreadyExited: true };
  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    let timer;
    const onExit = (exitCode, signalCode) => { clearTimeout(timer); resolve({ exited: true, exitCode, signalCode }); };
    child.once('exit', onExit);
    timer = setTimeout(() => { child.off('exit', onExit); resolve({ exited: false }); }, timeoutMs);
  });
  child.kill('SIGTERM');
  let exit = await waitForExit(8000);
  let forced = false;
  if (!exit.exited) {
    forced = true;
    child.kill('SIGKILL');
    exit = await waitForExit(5000);
  }
  return { stopped: exit.exited, exitCode: exit.exitCode ?? child.exitCode, signalCode: exit.signalCode ?? child.signalCode, forced };
}

async function runBenchmarkStage(journal, name, operation, project = (value) => value) {
  await journal.beginStage(name);
  try {
    const result = await operation();
    await journal.completeStage(name, project(result));
    return result;
  } catch (error) {
    await journal.failStage(name, error);
    throw error;
  }
}

function connectClient(entry, processes, lobby) {
  const processInfo = processes[entry.instance];
  const socket = createClient(processInfo.origin, {
    transports: ['websocket'], reconnection: false, forceNew: true, timeout: 10000,
    auth: { token: entry.token },
  });
  entry.socket = socket;
  lobby.socketRegistry?.add(socket);
  socket.on('lounge.queue.update', (message) => {
    const rows = message?.payload?.queue;
    if (!Array.isArray(rows)) return;
    const arrivedAt = performance.now();
    for (const waiter of lobby.queueWaiters.values()) {
      if (waiter.arrivals.has(entry.key)) continue;
      if (rows.some((row) => row.trackId === waiter.trackId)) {
        waiter.arrivals.set(entry.key, arrivedAt);
        if (waiter.arrivals.size >= lobby.clients.length) {
          waiter.withinDeadlineCount ??= waiter.arrivals.size;
          waiter.resolve({ arrivals: [...waiter.arrivals.values()], missing: 0 });
          waiter.settle();
        }
      }
    }
  });
  return socket;
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 12000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(new Error(`Socket connection failed: ${error.message}`)); });
  });
}

function socketCommand(socket, event, payload = {}, timeoutMs = 30000) {
  const started = performance.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ response: null, latencyMs: Number((performance.now() - started).toFixed(3)), timedOut: true }), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve({ response, latencyMs: Number((performance.now() - started).toFixed(3)), timedOut: false });
    });
  });
}

function makeQueueWaiter(lobby, trackId, startedAt) {
  let finishFirst;
  let finishSettled;
  let firstFinished = false;
  const promise = new Promise((resolve) => { finishFirst = resolve; });
  const settled = new Promise((resolve) => { finishSettled = resolve; });
  const waiter = {
    trackId,
    startedAt,
    arrivals: new Map(),
    resolve: (value) => {
      if (firstFinished) return;
      firstFinished = true;
      finishFirst(value);
    },
    settle: () => {
      clearTimeout(firstTimer);
      clearTimeout(graceTimer);
      const atDeadline = waiter.withinDeadlineCount ?? waiter.arrivals.size;
      finishSettled({ lateArrivals: Math.max(0, waiter.arrivals.size - atDeadline), stillMissing: lobby.clients.length - waiter.arrivals.size });
    },
  };
  const graceTimer = setTimeout(() => waiter.settle(), 18000);
  const firstTimer = setTimeout(() => {
    waiter.withinDeadlineCount = waiter.arrivals.size;
    waiter.resolve({ arrivals: [...waiter.arrivals.values()], missing: lobby.clients.length - waiter.arrivals.size });
  }, 8000);
  waiter.settled = settled;
  waiter.promise = promise;
  lobby.queueWaiters.set(trackId, waiter);
  return waiter;
}

async function requestLoad(origin, samples, concurrency) {
  const allLatencies = [];
  const successfulLatencies = [];
  const failedLatencies = [];
  const serverProcessingLatencies = [];
  const statusCounts = {};
  let successfulResponses = 0;
  let failedResponses = 0;
  let timeouts = 0;
  const started = performance.now();
  for (let offset = 0; offset < samples; offset += concurrency) {
    const group = Array.from({ length: Math.min(concurrency, samples - offset) }, async () => {
      const requestStarted = performance.now();
      const correlationId = crypto.randomUUID();
      try {
        const response = await fetch(`${origin}/api/v1/tracks?limit=10`, {
          headers: { 'x-astradj-benchmark-id': correlationId },
          signal: AbortSignal.timeout(10000),
        });
        const body = await response.json();
        const elapsed = Number((performance.now() - requestStarted).toFixed(3));
        allLatencies.push(elapsed);
        statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
        const valid = response.ok && Array.isArray(body.items);
        if (valid) {
          successfulResponses += 1;
          successfulLatencies.push(elapsed);
        } else {
          failedResponses += 1;
          failedLatencies.push(elapsed);
        }
        const serverTiming = response.headers.get('server-timing')?.match(/(?:^|,)\s*app;dur=([0-9.]+)/)?.[1];
        if (serverTiming !== undefined) serverProcessingLatencies.push(Number(serverTiming));
      } catch (error) {
        const elapsed = Number((performance.now() - requestStarted).toFixed(3));
        allLatencies.push(elapsed);
        failedLatencies.push(elapsed);
        failedResponses += 1;
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT') timeouts += 1;
      }
    });
    await Promise.all(group);
  }
  const elapsedMs = performance.now() - started;
  return {
    requests: samples,
    successfulResponses,
    failedResponses,
    timeouts,
    statusCounts,
    allLatencies,
    successfulLatencies,
    failedLatencies,
    serverProcessingLatencies,
    requestsPerSecond: Number((samples / (elapsedMs / 1000)).toFixed(2)),
    elapsedMs: Number(elapsedMs.toFixed(3)),
  };
}

async function clearDisposableRateLimitCounters() {
  // This benchmark has already asserted a unique loopback astradj_test_* DB.
  // Clear counters only between completed workload batches so normal limiter
  // reads/writes remain in each request's latency, without testing the quota.
  await RateLimitCounter.deleteMany({});
}

async function runQueueLoad(lobby, levels, samplesPerLevel) {
  const levelsResult = [];
  let sampleNo = 0;
  const allSuccessfulTrackIds = [];
  for (const concurrency of levels) {
    // Each level is an independent performance workload. Reset only the
    // disposable database's limiter state so earlier levels cannot consume
    // the production queue-add allowance for the same synthetic writers.
    await clearDisposableRateLimitCounters();
    const ackLatencies = [];
    const syncDrift = [];
    const senderToLast = [];
    const crossProcessToLast = [];
    const levelTrackIds = [];
    const levelWaiters = [];
    let attempted = 0;
    let errors = 0;
    let missingRecipients = 0;
    const workloadStart = performance.now();
    for (let offset = 0; offset < samplesPerLevel; offset += concurrency) {
      const count = Math.min(concurrency, samplesPerLevel - offset);
      const operations = Array.from({ length: count }, (_, localIndex) => {
        const trackId = `t_perf_add_${String(sampleNo++).padStart(5, '0')}`;
        const startedAt = performance.now();
        const waiter = makeQueueWaiter(lobby, trackId, startedAt);
        levelWaiters.push(waiter);
        const sender = lobby.writers[(offset + localIndex) % lobby.writers.length];
        return { trackId, startedAt, waiter, sender };
      });
      attempted += operations.length;
      const replies = await Promise.all(operations.map(async (operation) => ({
        operation,
        ...(await socketCommand(operation.sender.socket, 'lounge.queue.add', { trackId: operation.trackId }, 30000)),
      })));
      const observations = await Promise.all(replies.map(async ({ operation, response, latencyMs, timedOut }) => {
        if (timedOut || !response?.ok) {
          errors += 1;
          lobby.queueWaiters.delete(operation.trackId);
          operation.waiter.resolve({ arrivals: [], missing: lobby.clients.length });
          operation.waiter.withinDeadlineCount = operation.waiter.arrivals.size;
          operation.waiter.settle();
          return { operation, success: false, latencyMs, code: response?.error?.code ?? (timedOut ? 'ACK_TIMEOUT' : 'UNKNOWN_ERROR') };
        }
        ackLatencies.push(latencyMs);
        allSuccessfulTrackIds.push(operation.trackId);
        levelTrackIds.push(operation.trackId);
        const { arrivals, missing } = await operation.waiter.promise;
        missingRecipients += missing;
        if (arrivals.length) {
          syncDrift.push(Number((Math.max(...arrivals) - Math.min(...arrivals)).toFixed(3)));
          senderToLast.push(Number((Math.max(...arrivals) - operation.startedAt).toFixed(3)));
          const peerArrivals = [...operation.waiter.arrivals.entries()]
            .filter(([key]) => lobby.clients.find((client) => client.key === key)?.instance !== operation.sender.instance)
            .map(([, at]) => at);
          if (peerArrivals.length) crossProcessToLast.push(Number((Math.max(...peerArrivals) - operation.startedAt).toFixed(3)));
        }
        return { operation, success: true, latencyMs };
      }));
      for (const item of observations) item.operation.waiter.resolve({ arrivals: [], missing: lobby.clients.length });
    }
    const finalDelivery = await Promise.all(levelWaiters.map((waiter) => waiter.settled));
    for (const waiter of levelWaiters) lobby.queueWaiters.delete(waiter.trackId);
    const elapsedMs = performance.now() - workloadStart;
    const eventRows = await QueueEvent.find({ loungeId: lobby.loungeId, type: 'track.added', 'payload.trackId': { $in: levelTrackIds } }).select('seq payload.trackId').lean();
    const uniqueLogicalTrackIds = new Set(eventRows.map((event) => event.payload.trackId));
    const lounge = await DJLounge.findOne({ loungeId: lobby.loungeId }).select('coordination.state.items coordination.outbox').lean();
    const presentTracks = new Set((lounge?.coordination?.state?.items ?? []).map((item) => item.trackId));
    // Earlier IDs can be consumed by later lifecycle operations. Check only
    // additions from the current queue-load level.
    const missingState = levelTrackIds.filter((trackId) => !presentTracks.has(trackId)).length;
    levelsResult.push({
      concurrency, attempted, successful: ackLatencies.length, errors,
      errorRatePercent: Number((errors / attempted * 100).toFixed(3)),
      ackLatency: summarize(ackLatencies),
      queueStateSyncDrift: summarize(syncDrift),
      senderToLastClientDeliveryUpperBound: summarize(senderToLast),
      crossProcessSenderToLastClientDelivery: summarize(crossProcessToLast),
      clientsMissingAnEventSnapshot: missingRecipients,
      lateClientEventObservationsAfter8s: finalDelivery.reduce((sum, item) => sum + item.lateArrivals, 0),
      recipientsStillUnobservedAfter18s: finalDelivery.reduce((sum, item) => sum + item.stillMissing, 0),
      mutationEventsProjected: eventRows.length,
      duplicateLogicalEvents: eventRows.length - uniqueLogicalTrackIds.size,
      successfulMutationsMissingFromState: missingState,
      outboxBacklogAtEnd: lounge?.coordination?.outbox?.length ?? null,
      mutationsPerSecond: Number((ackLatencies.length / (elapsedMs / 1000)).toFixed(2)),
      elapsedMs: Number(elapsedMs.toFixed(3)),
    });
  }
  // Capture the queue-add invariant before segue transitions legitimately
  // consume queue entries later in the benchmark.
  const queueLoadLounge = await DJLounge.findOne({ loungeId: lobby.loungeId }).select('coordination.revision coordination.state.items coordination.outbox').lean();
  const queueLoadRows = allSuccessfulTrackIds.length
    ? await QueueEvent.find({ loungeId: lobby.loungeId, type: 'track.added', 'payload.trackId': { $in: allSuccessfulTrackIds } }).select('seq payload.trackId').lean()
    : [];
  const queueLoadIds = new Set((queueLoadLounge?.coordination?.state?.items ?? []).map((item) => item.trackId));
  const uniqueQueueLoadTrackIds = new Set(queueLoadRows.map((event) => event.payload.trackId));
  const syncResponses = await Promise.all(lobby.clients.map((client) => socketCommand(client.socket, 'lounge.sync.request', {}, 30000)));
  const expectedRevision = queueLoadLounge?.coordination?.revision ?? null;
  const resynchronizedClients = syncResponses.filter((result) => result.response?.ok && result.response.state?.revision === expectedRevision).length;
  return {
    levels: levelsResult,
    allSuccessfulTrackIds,
    queueLoadReconciliation: {
      successfulAdds: allSuccessfulTrackIds.length,
      persistedAddEvents: queueLoadRows.length,
      duplicateLogicalEvents: queueLoadRows.length - uniqueQueueLoadTrackIds.size,
      successfulAddsMissingFromEventLog: allSuccessfulTrackIds.filter((trackId) => !queueLoadRows.some((event) => event.payload.trackId === trackId)).length,
      successfulAddsMissingFromQueueState: allSuccessfulTrackIds.filter((trackId) => !queueLoadIds.has(trackId)).length,
      outboxBacklog: queueLoadLounge?.coordination?.outbox?.length ?? null,
      connectedClientsResynchronized: resynchronizedClients,
      connectedClientsExpected: lobby.clients.length,
    },
  };
}

async function waitForEvent(socket, name, predicate = () => true, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`Timed out waiting for ${name}`)); }, timeoutMs);
    const handler = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off(name, handler);
      resolve({ message, at: performance.now() });
    };
    socket.on(name, handler);
  });
}

function monitorSocketEvent(socket, name, predicate) {
  const records = [];
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const handler = (message) => {
    if (!predicate(message)) return;
    const record = {
      at: performance.now(),
      status: typeof message?.payload?.status === 'string' ? message.payload.status : null,
      trackId: typeof message?.payload?.trackId === 'string' ? message.payload.trackId : null,
      relatedTrackId: typeof message?.payload?.relatedTrackId === 'string' ? message.payload.relatedTrackId : null,
    };
    records.push(record);
    if (records.length === 1) resolveFirst(record);
  };
  socket.on(name, handler);
  return {
    records,
    async waitForFirst(timeoutMs = 3000) {
      if (records.length) return records[0];
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
      const result = await Promise.race([first, timeout]);
      clearTimeout(timer);
      return result;
    },
    close() { socket.off(name, handler); },
  };
}

async function inspectSoundclashSubmission({ loungeId, trackId, actorUserId }) {
  const [lounge, events] = await Promise.all([
    DJLounge.findOne({ loungeId }).select('coordination.state.soundclash coordination.outbox').maxTimeMS(5000).lean(),
    QueueEvent.find({ loungeId, type: 'soundclash.submitted', 'payload.trackId': trackId })
      .select('seq actorUserId payload.trackId')
      .maxTimeMS(5000)
      .lean(),
  ]);
  const battle = lounge?.coordination?.state?.soundclash;
  const committed = (battle?.submissions ?? []).some((submission) => (
    submission.trackId === trackId && String(submission.submittedByUserId) === String(actorUserId)
  ));
  const pendingOutbox = (lounge?.coordination?.outbox ?? []).filter((event) => (
    event.type === 'soundclash.submitted' && event.payload?.trackId === trackId
  )).length;
  const correctActorEvents = events.filter((event) => String(event.actorUserId) === String(actorUserId)).length;
  return {
    loungeFound: Boolean(lounge),
    snapshotCommitted: committed,
    battleStatus: battle?.status ?? null,
    candidateCount: battle?.candidateTrackIds?.length ?? 0,
    pendingOutboxEvents: pendingOutbox,
    projectedEventCount: events.length,
    projectedEventsForExpectedActor: correctActorEvents,
    projectedSequenceNumbers: events.map((event) => event.seq),
  };
}

async function inspectApiProcessHealth(processInfo) {
  if (!processInfo?.child || processInfo.child.exitCode !== null) {
    return { processId: processInfo?.child?.pid ?? null, alive: false, exitCode: processInfo?.child?.exitCode ?? null };
  }
  try {
    const response = await fetch(`${processInfo.origin}/health`, { signal: AbortSignal.timeout(3000) });
    return { processId: processInfo.child.pid, alive: true, healthStatus: response.status, healthOk: response.ok };
  } catch (error) {
    return { processId: processInfo.child.pid, alive: true, healthOk: false, healthErrorName: error.name ?? 'Error' };
  }
}

async function runSegueLoad(lobby, iterations) {
  const preparationAck = [];
  const triggerToPeerAnnouncement = [];
  const endedToPeerAnnouncement = [];
  const serviceSpans = new Map();
  const selectedTrackIds = [];
  const matchReasons = [];
  const transitions = [];
  const evidenceByTrack = Object.fromEntries(syntheticSegueTrackIds.map((trackId, index) => [trackId, {
    fixtureOnly: true, source: null, license: null, bpm: index === 0 ? 120 : 121, camelotKey: '8A',
  }]));

  const firstState = await socketCommand(lobby.hosts[0].socket, 'lounge.sync.request', {}, 15000);
  if (!firstState.response?.ok || !firstState.response.state?.nowPlaying) throw new Error('Segue benchmark could not read the initial Lounge state');
  let state = firstState.response.state;

  for (let index = 0; index < iterations; index += 1) {
    // Ten playback commands per Host fit the normal quota. Reset only this
    // unique benchmark database between five-transition batches; checks remain on.
    if (index > 0 && index % 5 === 0) await clearDisposableRateLimitCounters();
    const host = lobby.hosts[index % lobby.hosts.length];
    const peerHost = lobby.hosts.find((entry) => entry.instance !== host.instance);
    const currentTrackId = state.nowPlaying?.trackId;
    if (!syntheticSegueTrackIds.includes(currentTrackId)) throw new Error(`Unexpected synthetic segue source track: ${currentTrackId}`);
    const nextTrackId = syntheticSegueTrackIds.find((trackId) => trackId !== currentTrackId);
    if (!state.nextUp.some((track) => track.trackId === nextTrackId)) {
      const writer = lobby.writers[index % lobby.writers.length];
      const added = await socketCommand(writer.socket, 'lounge.queue.add', { trackId: nextTrackId }, 15000);
      if (!added.response?.ok) throw new Error(`Could not enqueue synthetic segue benchmark candidate: ${added.response?.error?.code ?? (added.timedOut ? 'ACK_TIMEOUT' : 'UNKNOWN_ERROR')}`);
      state = added.response.state;
    }
    const currentTrack = state.nowPlaying;
    const candidate = state.nextUp.find((track) => track.trackId === nextTrackId);
    if (!currentTrack || !candidate || !Number.isFinite(currentTrack.durationSeconds)) throw new Error('Synthetic segue benchmark fixture is missing duration or queued candidate metadata');
    const outroWindowSeconds = 12;
    const currentTs = currentTrack.durationSeconds - Math.min(5, outroWindowSeconds / 2);
    const startedAt = performance.now();
    const announced = waitForEvent(peerHost.socket, 'lounge.ai.dj_announcement', (message) => (
      message?.loungeId === lobby.loungeId && message.payload?.relatedTrackId === nextTrackId
    ), 15000);
    const trigger = await socketCommand(host.socket, 'lounge.ai.segue.trigger', { currentTs }, 15000);
    if (!trigger.response?.ok || trigger.response.decision?.selectedTrackId !== nextTrackId) {
      await announced.catch(() => {});
      const error = new Error(`Segue preparation failed: ${trigger.response?.error?.code ?? (trigger.timedOut ? 'ACK_TIMEOUT' : 'INCOMPATIBLE_OR_UNSELECTED')}`);
      error.code = trigger.response?.error?.code ?? (trigger.timedOut ? 'ACK_TIMEOUT' : 'SEGUE_NOT_SELECTED');
      error.timedOut = trigger.timedOut;
      throw error;
    }
    preparationAck.push(trigger.latencyMs);
    for (const [name, value] of Object.entries(trigger.response.runtimeDiagnostics?.spansMs ?? {})) {
      if (!Number.isFinite(value)) continue;
      if (!serviceSpans.has(name)) serviceSpans.set(name, []);
      serviceSpans.get(name).push(value);
    }
    selectedTrackIds.push(trigger.response.decision.selectedTrackId);
    matchReasons.push(trigger.response.decision.matchReason);
    const endedStartedAt = performance.now();
    const ended = await socketCommand(host.socket, 'lounge.playback.ended', { trackId: currentTrackId }, 15000);
    if (!ended.response?.ok) {
      await announced.catch(() => {});
      const error = new Error(`Playback transition command failed: ${ended.response?.error?.code ?? (ended.timedOut ? 'ACK_TIMEOUT' : 'UNKNOWN_ERROR')}`);
      error.code = ended.response?.error?.code ?? (ended.timedOut ? 'ACK_TIMEOUT' : 'TRANSITION_FAILED');
      error.timedOut = ended.timedOut;
      throw error;
    }
    const event = await announced;
    if (ended.response.state?.nowPlaying?.trackId !== nextTrackId) throw new Error('Segue persisted state did not advance to the selected compatible track');
    state = ended.response.state;
    preparationAck[preparationAck.length - 1] = Number(preparationAck.at(-1).toFixed(3));
    triggerToPeerAnnouncement.push(Number((event.at - startedAt).toFixed(3)));
    endedToPeerAnnouncement.push(Number((event.at - endedStartedAt).toFixed(3)));
    transitions.push({
      currentTrackId, selectedTrackId: nextTrackId,
      bpmRelation: trigger.response.decision.matchReason?.bpmRelation,
      bpmDeltaPct: trigger.response.decision.matchReason?.bpmDeltaPct,
      camelotRelation: trigger.response.decision.matchReason?.camelotRelation,
      provider: trigger.response.decision.provider,
      sourceReferenceCount: trigger.response.decision.sourceEvents?.length ?? 0,
    });
  }

  return {
    samplesRequested: iterations,
    samplesSelected: selectedTrackIds.length,
    selectionAndScriptPreparationAckMs: summarize(preparationAck),
    triggerToPeerSocketAnnouncementMs: summarize(triggerToPeerAnnouncement),
    endedCommandToPeerSocketAnnouncementMs: summarize(endedToPeerAnnouncement),
    serviceSpanLatencyMs: Object.fromEntries([...serviceSpans].map(([name, values]) => [name, summarize(values)])),
    selectedTrackIds,
    pairTrackIds: syntheticSegueTrackIds,
    pairMetadataEvidence: evidenceByTrack,
    fixtureLimitations: 'Synthetic, metadata-only tracks exist only in the disposable benchmark database. They are not licensed or playable catalog recordings and do not establish a real catalog transition pair.',
    matchReasons,
    transitions,
    latencyLimitations: 'The Host uses authenticated Socket.IO commands with currentTs inside the configured outro window. Opt-in spans cover Lounge lookup, current-track lookup, candidate retrieval, acoustic eligibility/ranking and transition-script/reference generation. The harness then sends lounge.playback.ended directly; no browser media element or React render is part of these timings. Peer Socket.IO arrival is not browser render latency.',
  };
}

async function recoveryAfterRestart(processes, lobby, mongoUri) {
  const targetInstance = 1;
  const previous = processes[targetInstance];
  const entries = lobby.clients.filter((entry) => entry.instance === targetInstance);
  const started = performance.now();
  for (const entry of entries) entry.socket.disconnect();
  await stopApiProcess(previous);
  const replacement = await startApiProcess(previous.port, mongoUri);
  processes[targetInstance] = replacement;
  const reconnected = entries.map((entry) => connectClient(entry, processes, lobby));
  const joins = await Promise.all(reconnected.map(async (socket) => {
    await waitForConnect(socket);
    return socketCommand(socket, 'lounge.join', { inviteCode: lobby.inviteCode }, 20000);
  }));
  const failedJoins = joins.filter((joined) => !joined.response?.ok);
  if (failedJoins.length) {
    const codes = failedJoins.map((joined) => joined.response?.error?.code ?? (joined.timedOut ? 'ACK_TIMEOUT' : 'UNKNOWN_ERROR'));
    throw new Error(`Restart recovery rejoin failed for ${failedJoins.length}/${joins.length} clients (${[...new Set(codes)].join(', ')})`);
  }
  const host = entries.find((entry) => entry.role === 'Host');
  const synced = await socketCommand(host.socket, 'lounge.sync.request', {}, 15000);
  if (!synced.response?.ok || !synced.response.state?.nowPlaying?.trackId) throw new Error('Restart sync did not restore Now Playing');
  const stored = await DJLounge.findOne({ loungeId: lobby.loungeId }).select('coordination.revision coordination.state.currentTrackId coordination.state.items').lean();
  if (synced.response.state.revision !== stored?.coordination?.revision || synced.response.state.nowPlaying.trackId !== stored.coordination.state.currentTrackId) {
    throw new Error('Restarted process returned a state inconsistent with persisted Lounge coordination');
  }
  return { passed: true, connectedClientsRecovered: entries.length, restoredRevision: stored.coordination.revision, queueItems: stored.coordination.state.items.length, restartAndResyncMs: Number((performance.now() - started).toFixed(3)) };
}

async function main() {
  const startedAt = new Date();
  const target = describeConfiguredMongoTarget(configuredUri);
  const startHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  const startStatus = execFileSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8' }).trim();
  const indexHtmlSha256AtStart = crypto.createHash('sha256').update(await readFile(path.resolve(rootDir, '..', 'index.html'))).digest('hex');
  const manifest = { benchmark: 'AstraDJ runtime performance and Soundclash diagnostics', runId: benchmarkRunId, startedAt: startedAt.toISOString(), startingHead: startHead, worktree: { dirtyAtStart: Boolean(startStatus), statusEntryCount: startStatus ? startStatus.split(/\r?\n/).length : 0 }, runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, cpuModel: os.cpus()[0]?.model ?? 'unknown', logicalCpuCount: os.cpus().length, totalMemoryGiB: +(os.totalmem() / 1024 ** 3).toFixed(2), freeMemoryGiBAtStart: +(os.freemem() / 1024 ** 3).toFixed(2), expectedApiProcesses: 2, expectedSockets: 51, browserStressLaunched: false }, database: { configuredTarget: target, generatedIsolatedDatabase: null, uriRecorded: false, requiredHostScope: 'loopback', requiredNamespace: 'astradj_test_*' }, configuration: { apiSamplesPerProcessPerConcurrency: apiSamples, apiConcurrencyPerProcess: apiConcurrencyLevels, queueSamplesPerConcurrency: queueSamplesPerLevel, queueConcurrency: queueConcurrencyLevels, segueSamples, soundclashVoters: soundclashVoteCount, warmupRequestsPerProcess: warmupSamples, normalRateLimitsEnabled: true }, prdTargets: { apiP95Ms: 200, segueTransitionP95Ms: 3000, queueSyncDriftMs: 100, websocketFanoutMs: 500 }, method: { percentiles: 'nearest-rank', api: 'Loopback GET /api/v1/tracks?limit=10; Server-Timing is app-path duration; Mongo subquery spans are not instrumented.', segue: 'Authenticated Host outro-trigger and playback.ended commands using source-evidenced seed pair; no browser or actual audio.', soundclash: 'Authenticated Listener submissions with {trackId}; inspect durable snapshot, outbox and projected QueueEvent after ack/timeout.', rateLimits: 'Production limiter remains enabled; only isolated database counters reset between workload batches.' }, stagePlan: plannedStages };
  manifest.worktree.indexHtmlSha256AtStart = indexHtmlSha256AtStart;
  const journal = await createRuntimeBenchmarkJournal({ baseDirectory: path.resolve(rootDir, '..', 'docs', 'runtime-benchmark-runs'), runId: benchmarkRunId, manifest, plannedStages, secrets: [configuredUri, benchmarkSecret].filter(Boolean) });
  const totalStarted = performance.now();
  let isolatedMongoUri = null;
  let isolatedDatabaseName = null;
  let connected = false;
  let topology = null;
  let buildInfo = null;
  let processes = [];
  const socketRegistry = new Set();
  let clientEntries = [];
  let lobby = null;
  let writers = [];
  let hosts = [];
  let listeners = [];
  let loungeId = null;
  let hostId = null;
  let inviteCode = null;
  let stageTrackIds = [];
  let queueLoad = null;
  let failure = null;
  let cleanupStatus = 'not_started';
  try {
    await runBenchmarkStage(journal, 'database_guard_and_connect', async () => {
      const safe = assertSafeTestMongoUri(configuredUri);
      const isolated = createIsolatedMongoTestDatabase(configuredUri, 'runtimebench');
      isolatedMongoUri = isolated.uri;
      isolatedDatabaseName = isolated.databaseName;
      manifest.database.generatedIsolatedDatabase = isolatedDatabaseName;
      await mongoose.connect(isolatedMongoUri, { serverSelectionTimeoutMS: 5000 });
      connected = true;
      topology = await mongoose.connection.db.admin().command({ hello: 1 });
      buildInfo = await mongoose.connection.db.admin().command({ buildInfo: 1 });
      return { guardPassed: true, configuredHostname: safe.hostname, generatedDatabaseName: isolatedDatabaseName, topology: topology.setName ? 'replicaSet' : (topology.msg === 'isdbgrid' ? 'mongos' : 'standalone'), mongoVersion: buildInfo.version, freeMemoryGiB: +(os.freemem() / 1024 ** 3).toFixed(2) };
    });
    await runBenchmarkStage(journal, 'seed_fixture', async () => {
      const now = new Date();
      loungeId = `lg_${crypto.randomBytes(8).toString('hex')}`;
      inviteCode = `SP-${crypto.randomBytes(2).toString('hex').toUpperCase().replace(/[01]/g, 'A')}`;
      hostId = new mongoose.Types.ObjectId();
      const coDjIds = Array.from({ length: 25 }, () => new mongoose.Types.ObjectId());
      const listenerIds = Array.from({ length: 24 }, () => new mongoose.Types.ObjectId());
      const allIds = [hostId, ...coDjIds, ...listenerIds];
      const users = allIds.map((id, index) => ({ _id: id, email: `perf-${String(id)}@example.invalid`, displayName: `Benchmark ${index}`, passwordHash: 'unused-benchmark-only-value', role: index === 0 ? 'Host' : index <= coDjIds.length ? 'Co-DJ' : 'Listener' }));
      const queueTrackIds = Array.from({ length: queueSamplesPerLevel * queueConcurrencyLevels.length + 40 }, (_, index) => `t_perf_add_${String(index).padStart(5, '0')}`);
      stageTrackIds = Array.from({ length: 10 }, (_, index) => `t_perf_stage_${String(index).padStart(3, '0')}`);
      const syntheticTracks = [...queueTrackIds, ...stageTrackIds].map(makeQueueBenchmarkTrack);
      const syntheticSegueTracks = [makeSyntheticSegueTrack(syntheticSegueTrackIds[0], 120), makeSyntheticSegueTrack(syntheticSegueTrackIds[1], 121)];
      await Promise.all([User.init(), Track.init(), DJLounge.init(), QueueEvent.init(), RateLimitCounter.init()]);
      await User.create(users);
      await Track.create([...seedTracks, ...syntheticTracks, ...syntheticSegueTracks]);
      await DJLounge.create({ loungeId, inviteCode, hostUserId: hostId, vibeProfile: 'Isolated performance workload', queue: syntheticSegueTrackIds, currentTrackId: syntheticSegueTrackIds[0], status: 'live', participantIds: allIds, createdAt: now, startedAt: now, analyticsTrackingVersion: 1, sessionEventSeq: 0, settings: { maxParticipants: 50, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' } });
      return { usersCreated: users.length, roleCounts: { Host: 1, 'Co-DJ': coDjIds.length, Listener: listenerIds.length }, realSeedTracks: seedTracks.length, syntheticQueueTracks: syntheticTracks.length, syntheticSegueTracks: syntheticSegueTracks.length, syntheticTracksHaveAcousticProfiles: false, loungeId, initialNowPlayingTrackId: syntheticSegueTrackIds[0], initialNextUpTrackId: syntheticSegueTrackIds[1], seguePair: syntheticSegueTrackIds.map((trackId) => { const track = syntheticSegueTracks.find((item) => item.trackId === trackId); return { trackId, bpm: track.acoustic.bpm, camelotKey: track.acoustic.camelotKey, source: null, license: null, fixtureOnly: true }; }), soundclashCandidates: soundclashTrackIds };
    });
    await runBenchmarkStage(journal, 'start_api_processes', async () => {
      const ports = [await reservePort(), await reservePort()];
      for (const port of ports) processes.push(await startApiProcess(port, isolatedMongoUri));
      return { processCount: processes.length, processStartup: processes.map(({ child, port, startupMs }) => ({ pid: child.pid, port, startupMs })) };
    });
    await runBenchmarkStage(journal, 'connect_and_join_clients', async () => {
      const [coDjIds, listenerIds] = await Promise.all([User.find({ role: 'Co-DJ' }).select('_id').lean(), User.find({ role: 'Listener' }).select('_id').lean()]);
      clientEntries = [];
      const addEntry = (id, role, instance, ordinal) => clientEntries.push({ key: `${String(id)}:${instance}:${ordinal}`, userId: String(id), role, instance, token: makeToken(id), socket: null });
      addEntry(hostId, 'Host', 0, 0); addEntry(hostId, 'Host', 1, 1);
      coDjIds.forEach(({ _id }, index) => addEntry(_id, 'Co-DJ', index % 2, 0));
      listenerIds.forEach(({ _id }, index) => addEntry(_id, 'Listener', index % 2, 0));
      lobby = { loungeId, inviteCode, clients: clientEntries, queueWaiters: new Map(), socketRegistry };
      for (const entry of clientEntries) entry.socket = connectClient(entry, processes, lobby);
      await Promise.all(clientEntries.map(async (entry) => { await waitForConnect(entry.socket); const joined = await socketCommand(entry.socket, 'lounge.join', { inviteCode }, 20000); if (!joined.response?.ok) throw new Error(`Benchmark client join failed: ${joined.response?.error?.code ?? (joined.timedOut ? 'ACK_TIMEOUT' : 'UNKNOWN_ERROR')}`); }));
      writers = clientEntries.filter((entry) => entry.role === 'Co-DJ'); hosts = clientEntries.filter((entry) => entry.role === 'Host'); listeners = clientEntries.filter((entry) => entry.role === 'Listener');
      lobby.writers = writers; lobby.hosts = hosts;
      return { socketConnections: clientEntries.length, distinctParticipantAccounts: new Set(clientEntries.map((entry) => entry.userId)).size, joinedAcks: clientEntries.length, hostSocketsAcrossProcesses: hosts.length, coDjAccounts: writers.length, listenerAccounts: listeners.length };
    });
    const apiRead = await runBenchmarkStage(journal, 'api_catalog_reads', async () => {
      let warmups = 0;
      for (let i = 0; i < warmupSamples; i += 1) { const response = await fetch(`${processes[i % processes.length].origin}/api/v1/tracks?limit=10`); if (!response.ok) throw new Error(`API warm-up failed HTTP ${response.status}`); warmups += 1; }
      const levels = [];
      for (const concurrency of apiConcurrencyLevels) {
        const rows = processes.map(() => ({ requests: 0, success: [], fail: [], all: [], app: [], failures: 0, timeouts: 0, statuses: {}, elapsed: 0 }));
        for (let offset = 0; offset < apiSamples; offset += 50) {
          const size = Math.min(50, apiSamples - offset); await clearDisposableRateLimitCounters();
          const batches = await Promise.all(processes.map((processInfo) => requestLoad(processInfo.origin, size, concurrency)));
          batches.forEach((batch, index) => { const row = rows[index]; row.requests += batch.requests; row.success.push(...batch.successfulLatencies); row.fail.push(...batch.failedLatencies); row.all.push(...batch.allLatencies); row.app.push(...batch.serverProcessingLatencies); row.failures += batch.failedResponses; row.timeouts += batch.timeouts; row.elapsed += batch.elapsedMs; for (const [status, count] of Object.entries(batch.statusCounts)) row.statuses[status] = (row.statuses[status] ?? 0) + count; });
        }
        const perProcess = rows.map((row, index) => ({ processOrdinal: index + 1, requests: row.requests, successes: row.success.length, failures: row.failures, timeouts: row.timeouts, errorRatePercent: +(100 * row.failures / row.requests).toFixed(3), httpStatusCounts: row.statuses, responseLatencyMs: summarize(row.all), successLatencyMs: summarize(row.success), failedLatencyMs: summarize(row.fail), serverAppPathLatencyMs: summarize(row.app), requestsPerSecond: +(row.requests / Math.max(0.001, row.elapsed / 1000)).toFixed(2) }));
        const all = rows.flatMap((row) => row.all); const success = rows.flatMap((row) => row.success); const app = rows.flatMap((row) => row.app); const requestCount = rows.reduce((sum, row) => sum + row.requests, 0); const failures = rows.reduce((sum, row) => sum + row.failures, 0);
        levels.push({ concurrencyPerProcess: concurrency, aggregate: { requests: requestCount, successes: requestCount - failures, failures, timeouts: rows.reduce((sum, row) => sum + row.timeouts, 0), errorRatePercent: +(100 * failures / requestCount).toFixed(3), responseLatencyMs: summarize(all), successLatencyMs: summarize(success), serverAppPathLatencyMs: summarize(app) }, perProcess, note: 'Normal rate limiting remained active; only disposable Mongo counters were cleared between batches. DB subquery spans are not instrumented.' });
      }
      return { endpoint: 'GET /api/v1/tracks?limit=10', warmupRequests: warmups, configuredSamplesPerProcessPerLevel: apiSamples, levels };
    });
    const segue = await runBenchmarkStage(journal, 'segue_measurement', () => runSegueLoad(lobby, segueSamples));
    queueLoad = await runBenchmarkStage(journal, 'queue_mutations', () => runQueueLoad(lobby, queueConcurrencyLevels, queueSamplesPerLevel), (value) => ({ levels: value.levels, queueLoadReconciliation: value.queueLoadReconciliation, successfulTrackIdCount: value.allSuccessfulTrackIds.length }));
    const outbox = await runBenchmarkStage(journal, 'outbox_stage_observations', async () => {
      await clearDisposableRateLimitCounters(); const observations = [];
      for (const [index, trackId] of stageTrackIds.entries()) {
        const writer = writers[index % writers.length]; const start = performance.now(); const command = socketCommand(writer.socket, 'lounge.queue.add', { trackId }, 20000); let commit = null; let projected = null; let drained = null; const deadline = start + 10000;
        while (performance.now() < deadline && drained === null) { const doc = await DJLounge.findOne({ loungeId }).select('coordination').lean(); if (doc?.coordination?.state?.items?.some((item) => item.trackId === trackId) && commit === null) commit = performance.now(); const eventExists = await QueueEvent.exists({ loungeId, type: 'track.added', 'payload.trackId': trackId }); if (eventExists && projected === null) projected = performance.now(); const pending = doc?.coordination?.outbox?.some((event) => event.payload?.trackId === trackId); if (eventExists && !pending) drained = performance.now(); if (drained === null) await new Promise((resolve) => setTimeout(resolve, 1)); }
        const reply = await command; if (!reply.response?.ok) { const error = new Error(`Outbox mutation failed: ${reply.response?.error?.code ?? (reply.timedOut ? 'ACK_TIMEOUT' : 'UNKNOWN_ERROR')}`); error.code = reply.response?.error?.code ?? (reply.timedOut ? 'ACK_TIMEOUT' : 'OUTBOX_MUTATION_FAILED'); error.timedOut = reply.timedOut; throw error; }
        observations.push({ ackMs: reply.latencyMs, commitObservedMs: commit === null ? null : +(commit - start).toFixed(3), projectionAfterCommitMs: projected === null || commit === null ? null : +(projected - commit).toFixed(3), drainAfterProjectionMs: drained === null || projected === null ? null : +(drained - projected).toFixed(3) });
      }
      return { samples: observations.length, ackMs: summarize(observations.map((row) => row.ackMs)), commitObservedMs: summarize(observations.map((row) => row.commitObservedMs).filter(Number.isFinite)), projectionAfterCommitMs: summarize(observations.map((row) => row.projectionAfterCommitMs).filter(Number.isFinite)), drainAfterProjectionMs: summarize(observations.map((row) => row.drainAfterProjectionMs).filter(Number.isFinite)), observations, note: 'Milestones use 1ms polling from the benchmark process and are upper bounds including poll/query time.' };
    });
    async function submitSoundclash(entry, trackId, opening) {
      const correlationId = benchmarkCorrelationId(loungeId, trackId);
      const hostMonitors = hosts.map((host) => monitorSocketEvent(host.socket, opening ? 'lounge.soundclash.open' : 'lounge.soundclash.submission', (message) => message?.loungeId === loungeId && (opening ? message.payload?.candidateTrackIds?.includes(trackId) : message.payload?.trackId === trackId)));
      const remoteListener = listeners.find((item) => item.instance !== entry.instance && item.userId !== entry.userId);
      const listenerMonitor = remoteListener ? monitorSocketEvent(remoteListener.socket, 'lounge.soundclash.submission', (message) => message?.loungeId === loungeId && message.payload?.trackId === trackId) : null;
      const reply = await socketCommand(entry.socket, 'lounge.soundclash.submit', { trackId }, 30000);
      let durable; try { durable = await inspectSoundclashSubmission({ loungeId, trackId, actorUserId: entry.userId }); } catch (error) { durable = { inspectionFailed: true, inspectionErrorName: error.name ?? 'Error' }; }
      const hostEvents = await Promise.all(hostMonitors.map((monitor) => monitor.waitForFirst(1000))); const listenerEvent = listenerMonitor ? await listenerMonitor.waitForFirst(1000) : null; hostMonitors.forEach((monitor) => monitor.close()); listenerMonitor?.close();
      const trace = processes[entry.instance].getRuntimeDiagnostics(correlationId).map(({ stage, code, status }) => ({ stage, ...(code ? { code } : {}), ...(status ? { status } : {}) }));
      const details = { correlationId, contract: { event: 'lounge.soundclash.submit', payloadKeys: ['trackId'], expectedRole: 'Listener', authenticated: true, joinedLounge: true }, acknowledgement: { received: Boolean(reply.response), ok: reply.response?.ok ?? false, code: reply.response?.error?.code ?? null, timedOut: reply.timedOut, latencyMs: reply.latencyMs }, durable, socketEvents: { hostReceipts: hostEvents.filter(Boolean).length, remoteHostReceived: hostEvents.some((event, index) => Boolean(event) && hosts[index].instance !== entry.instance), otherListenerReceivedSubmission: Boolean(listenerEvent) }, serverTraceStages: trace, processHealth: await inspectApiProcessHealth(processes[entry.instance]) };
      if (!reply.response?.ok || !durable.snapshotCommitted || durable.projectedEventsForExpectedActor !== 1 || durable.pendingOutboxEvents !== 0 || (opening && durable.battleStatus !== 'open')) { const error = new Error('Soundclash submission acknowledgement/durable-state/event reconciliation failed'); error.code = reply.response?.error?.code ?? (reply.timedOut ? 'ACK_TIMEOUT' : 'SOUNDCLASH_RECONCILIATION_FAILED'); error.timedOut = reply.timedOut; error.diagnostics = details; throw error; }
      return details;
    }
    await runBenchmarkStage(journal, 'soundclash_submit_first', () => submitSoundclash(listeners[0], soundclashTrackIds[0], false));
    await runBenchmarkStage(journal, 'soundclash_submit_second', () => submitSoundclash(listeners[1], soundclashTrackIds[1], true));
    await runBenchmarkStage(journal, 'soundclash_vote_wave', async () => {
      const sync = await socketCommand(hosts[0].socket, 'lounge.sync.request', {}, 15000); const battleId = sync.response?.state?.soundclash?.battleId; if (!battleId || sync.response.state.soundclash.status !== 'open') throw new Error('Soundclash is not open before votes');
      const started = performance.now(); const replies = await Promise.all(Array.from({ length: soundclashVoteCount }, (_, index) => socketCommand(listeners[index].socket, 'lounge.soundclash.vote', { battleId, trackId: soundclashTrackIds[index % 2] }, 30000))); const accepted = replies.filter((reply) => reply.response?.ok); const events = await QueueEvent.find({ loungeId, type: 'soundclash.voted', 'payload.battleId': battleId }).select('actorUserId').lean(); const voters = new Set(events.map((event) => String(event.actorUserId))).size;
      if (accepted.length !== soundclashVoteCount || events.length !== accepted.length || voters !== accepted.length) throw new Error('Vote acknowledgements did not reconcile with unique persisted votes');
      const battle = await DJLounge.findOne({ loungeId }).select('coordination.state.soundclash.closesAt').lean(); const closeDelay = Math.max(0, new Date(battle.coordination.state.soundclash.closesAt).getTime() - Date.now()); const tieMonitor = monitorSocketEvent(hosts[0].socket, 'lounge.soundclash.vote', (message) => message?.loungeId === loungeId && message.payload?.status === 'tied'); const tie = await tieMonitor.waitForFirst(closeDelay + 10000); tieMonitor.close(); if (!tie) throw new Error('Timed Soundclash tie was not observed by its stored deadline');
      return { battleId, requestedVotes: replies.length, successfulVotes: accepted.length, failedVotes: replies.length - accepted.length, timeouts: replies.filter((reply) => reply.timedOut).length, persistedVoteEvents: events.length, distinctPersistedVoters: voters, voteAckLatencyMs: summarize(accepted.map((reply) => reply.latencyMs)), voteWaveMs: +(performance.now() - started).toFixed(3), tieBroadcastReceived: true };
    });
    await runBenchmarkStage(journal, 'soundclash_resolution', async () => {
      const sync = await socketCommand(hosts[0].socket, 'lounge.sync.request', {}, 15000); const battle = sync.response?.state?.soundclash; if (!battle?.battleId || battle.status !== 'tied') throw new Error('Soundclash is not tied before resolution'); const winningTrackId = battle.candidateTrackIds[0]; const start = performance.now(); const event = waitForEvent(listeners[1].socket, 'lounge.soundclash.resolved', (message) => message?.loungeId === loungeId && message.payload?.battleId === battle.battleId, 15000); const reply = await socketCommand(hosts[0].socket, 'lounge.soundclash.resolve', { battleId: battle.battleId, winningTrackId }, 15000); if (!reply.response?.ok) throw new Error(`Soundclash resolve rejected: ${reply.response?.error?.code ?? (reply.timedOut ? 'ACK_TIMEOUT' : 'UNKNOWN_ERROR')}`); const broadcast = await event; const [count, stored] = await Promise.all([QueueEvent.countDocuments({ loungeId, type: 'soundclash.resolved', 'payload.battleId': battle.battleId }), DJLounge.findOne({ loungeId }).select('coordination.state.soundclash.status').lean()]); if (count !== 1 || stored?.coordination?.state?.soundclash?.status !== 'resolved') throw new Error('Soundclash resolution did not reconcile with persisted state'); return { battleId: battle.battleId, winningTrackId, ackMs: reply.latencyMs, peerBroadcastMs: +(broadcast.at - start).toFixed(3), persistedResolutionEvents: count, persistedStatus: stored.coordination.state.soundclash.status };
    });
    await runBenchmarkStage(journal, 'gateway_restart_recovery', () => recoveryAfterRestart(processes, lobby, isolatedMongoUri));
    await runBenchmarkStage(journal, 'final_reconciliation', async () => {
      const [doc, eventCount, adds, transitions, battles] = await Promise.all([DJLounge.findOne({ loungeId }).select('coordination.revision coordination.state.currentTrackId coordination.state.items coordination.outbox coordination.state.soundclash').lean(), QueueEvent.countDocuments({ loungeId }), QueueEvent.find({ loungeId, type: 'track.added' }).select('payload.trackId').lean(), QueueEvent.find({ loungeId, type: 'track.transitioned' }).select('payload.trackId').lean(), QueueEvent.find({ loungeId, type: /^soundclash\./ }).select('type').lean()]); const ids = adds.map((row) => row.payload.trackId); const counts = new Map(); for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1); const stateIds = new Set((doc?.coordination?.state?.items ?? []).map((item) => item.trackId)); const missingIds = [...counts.keys()].filter((id) => !stateIds.has(id)); const repeated = [...counts].filter(([, count]) => count > 1).map(([trackId, count]) => ({ trackId, eventCount: count, expectedSeguePairRequeue: syntheticSegueTrackIds.includes(trackId) }));
      return { revision: doc?.coordination?.revision ?? null, currentTrackId: doc?.coordination?.state?.currentTrackId ?? null, queueStateItems: stateIds.size, addEventRows: adds.length, repeatedTrackAddIds: repeated, unexpectedRepeatedTrackIds: repeated.filter((item) => !item.expectedSeguePairRequeue), distinctTrackAddIdsAbsentFromFinalQueue: missingIds, laterLifecycleAddIdsNotRetained: missingIds.length, segueTransitionEvents: transitions.length, totalQueueEvents: eventCount, soundclashEvents: Object.fromEntries([...new Set(battles.map((row) => row.type))].map((type) => [type, battles.filter((row) => row.type === type).length])), finalSoundclashStatus: doc?.coordination?.state?.soundclash?.status ?? null, outboxBacklog: doc?.coordination?.outbox?.length ?? null, queueLoadReconciliation: queueLoad?.queueLoadReconciliation ?? null, note: 'Repeated track IDs are separate successful add operations for the CC0 segue pair when a pair member was consumed and later re-enqueued. Final-snapshot absence is measured after playback/Soundclash lifecycle; the queue-load stage separately reconciles all 400 additions immediately before those later operations.' };
    });
  } catch (error) {
    failure = error;
    try { const failed = journal.state.stages.findLast((stage) => stage.status === 'failed' || stage.status === 'timed_out')?.name ?? 'benchmark failure'; await journal.skipPendingStages(`Skipped after ${failed}`, ['cleanup']); } catch (writeError) { failure.journalError = summarizeBenchmarkError(writeError, [configuredUri, benchmarkSecret].filter(Boolean)); }
  } finally {
    try {
      await runBenchmarkStage(journal, 'cleanup', async () => {
        for (const socket of socketRegistry) socket.disconnect(); const shutdown = await Promise.all(processes.map((item) => stopApiProcess(item))); let databaseDropped = false;
        if (connected && isolatedDatabaseName) { await dropIsolatedMongoTestDatabase(mongoose, isolatedDatabaseName); connected = false; databaseDropped = true; }
        if (shutdown.some((item) => !item.stopped)) throw new Error('A benchmark API process did not stop cleanly'); cleanupStatus = 'completed';
        return { databaseDropped, databaseName: isolatedDatabaseName, guardedDisposableNamespace: true, apiProcessesStopped: shutdown.filter((item) => item.stopped).length, forcedStops: shutdown.filter((item) => item.forced).length, disconnectedSockets: socketRegistry.size, mongooseDisconnected: mongoose.connection.readyState === 0 };
      });
      if (cleanupStatus === 'not_started') cleanupStatus = 'completed';
    } catch (error) { cleanupStatus = 'failed'; failure ??= error; }
    let finalHead = null; let statusCount = null; let indexHash = null;
    try { finalHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(); const status = execFileSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8' }).trim(); statusCount = status ? status.split(/\r?\n/).length : 0; indexHash = crypto.createHash('sha256').update(await readFile(path.resolve(rootDir, '..', 'index.html'))).digest('hex'); } catch { /* Supplemental git metadata. */ }
    try { const final = await journal.finish({ cleanupStatus, finalData: { durationMs: +(performance.now() - totalStarted).toFixed(3), finalHead, worktreeStatusEntryCountAtStart: manifest.worktree.statusEntryCount, worktreeStatusEntryCountAtEnd: statusCount, indexHtmlSha256AtEnd: indexHash, indexHtmlUnchanged: indexHash === indexHtmlSha256AtStart, failureSummary: failure ? summarizeBenchmarkError(failure, [configuredUri, benchmarkSecret, isolatedMongoUri].filter(Boolean)) : null, resourcesAtEnd: { freeMemoryGiB: +(os.freemem() / 1024 ** 3).toFixed(2), processRssMiB: +(process.memoryUsage().rss / 1024 ** 2).toFixed(1) } } }); console.log(`Runtime benchmark ${final.complete ? 'complete' : 'partial'} report: ${final.reportPath}`); console.log(`Starting HEAD ${startHead}; final HEAD ${finalHead ?? 'unavailable'}; cleanup ${cleanupStatus}`); } catch (error) { console.error(`Journal finalization failed: ${summarizeBenchmarkError(error, [configuredUri, benchmarkSecret, isolatedMongoUri].filter(Boolean)).message}`); failure ??= error; }
    if (failure || cleanupStatus === 'failed') process.exitCode = 1;
  }
}
main().catch((error) => { console.error(`Runtime benchmark could not initialize its journal: ${summarizeBenchmarkError(error, [configuredUri, benchmarkSecret].filter(Boolean)).message}`); process.exitCode = 1; });
