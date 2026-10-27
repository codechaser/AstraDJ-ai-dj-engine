import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { io as createClient } from 'socket.io-client';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from '../tests/mongoTestDatabase.js';
import { User } from '../src/models/User.js';
import { Track } from '../src/models/Track.js';
import { DJLounge } from '../src/models/DJLounge.js';
import { QueueEvent } from '../src/models/QueueEvent.js';

const configuredUri = process.env.MONGODB_TEST_URI;
const apiSamples = numberSetting('BENCH_API_SAMPLES', 500, 100, 5000);
const queueSamplesPerLevel = numberSetting('BENCH_QUEUE_SAMPLES_PER_LEVEL', 100, 10, 500);
const queueConcurrencyLevels = [1, 5, 10, 20];
const apiConcurrencyLevels = [1, 10, 25];
const soundclashVoteCount = 20;
const segueSamples = 20;
const warmupSamples = 25;
const benchmarkSecret = crypto.randomBytes(48).toString('hex');
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

function makeTrack(trackId, title, { bpm = 120, key = '8A', audioAssetUrl = null } = {}) {
  return {
    trackId, title, artist: 'Runtime benchmark fixture', durationSeconds: 180, audioAssetUrl,
    acoustic: { bpm, camelotKey: key, energy: 0.55, valence: 0.55 },
    timeline: [{ ts: 15, type: 'trivia', text: 'Synthetic fact used only by the isolated performance fixture.' }],
  };
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
  };
  const child = spawn(process.execPath, [entryPath], { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (data) => { output = (output + data.toString()).slice(-5000); });
  child.stderr.on('data', (data) => { output = (output + data.toString()).slice(-5000); });
  const origin = `http://127.0.0.1:${port}`;
  const startupStarted = performance.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API process exited during startup: ${sanitizedOutput(output, mongoUri)}`);
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { child, origin, port, startupMs: Number((performance.now() - startupStarted).toFixed(3)) };
    } catch { /* The server has not bound yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`API process did not become healthy: ${sanitizedOutput(output, mongoUri)}`);
}

async function stopApiProcess(processInfo) {
  if (!processInfo?.child || processInfo.child.exitCode !== null) return;
  const child = processInfo.child;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))]);
  if (child.exitCode === null) child.kill();
}

function connectClient(entry, processes, lobby) {
  const processInfo = processes[entry.instance];
  const socket = createClient(processInfo.origin, {
    transports: ['websocket'], reconnection: false, forceNew: true, timeout: 10000,
    auth: { token: entry.token },
  });
  entry.socket = socket;
  socket.on('lounge.queue.update', (message) => {
    const rows = message?.payload?.queue;
    if (!Array.isArray(rows)) return;
    const arrivedAt = performance.now();
    for (const waiter of lobby.queueWaiters.values()) {
      if (waiter.arrivals.has(entry.key)) continue;
      if (rows.some((row) => row.trackId === waiter.trackId)) {
        waiter.arrivals.set(entry.key, arrivedAt);
        if (waiter.arrivals.size >= lobby.clients.length) waiter.resolve({ arrivals: [...waiter.arrivals.values()], missing: 0 });
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
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  const waiter = { trackId, startedAt, arrivals: new Map(), resolve: (value) => finish(value) };
  const timer = setTimeout(() => finish({ arrivals: [...waiter.arrivals.values()], missing: lobby.clients.length - waiter.arrivals.size }), 8000);
  waiter.promise = promise.finally(() => clearTimeout(timer));
  lobby.queueWaiters.set(trackId, waiter);
  return waiter;
}

async function requestLoad(origin, samples, concurrency) {
  const latencies = [];
  let errors = 0;
  const started = performance.now();
  for (let offset = 0; offset < samples; offset += concurrency) {
    const group = Array.from({ length: Math.min(concurrency, samples - offset) }, async () => {
      const requestStarted = performance.now();
      try {
        const response = await fetch(`${origin}/api/v1/tracks?limit=10`, { signal: AbortSignal.timeout(10000) });
        const body = await response.json();
        latencies.push(Number((performance.now() - requestStarted).toFixed(3)));
        if (!response.ok || !Array.isArray(body.items)) errors += 1;
      } catch { errors += 1; }
    });
    await Promise.all(group);
  }
  const elapsedMs = performance.now() - started;
  return { ...summarize(latencies), errors, errorRatePercent: Number((errors / samples * 100).toFixed(3)), requestsPerSecond: Number((samples / (elapsedMs / 1000)).toFixed(2)), elapsedMs: Number(elapsedMs.toFixed(3)) };
}

async function runQueueLoad(lobby, levels, samplesPerLevel) {
  const levelsResult = [];
  let sampleNo = 0;
  const allSuccessfulTrackIds = [];
  for (const concurrency of levels) {
    const ackLatencies = [];
    const syncDrift = [];
    const senderToLast = [];
    const crossProcessToLast = [];
    const levelTrackIds = [];
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
          return { operation, success: false, latencyMs, code: response?.error?.code ?? (timedOut ? 'ACK_TIMEOUT' : 'UNKNOWN_ERROR') };
        }
        ackLatencies.push(latencyMs);
        allSuccessfulTrackIds.push(operation.trackId);
        levelTrackIds.push(operation.trackId);
        const { arrivals, missing } = await operation.waiter.promise;
        lobby.queueWaiters.delete(operation.trackId);
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
  const queueLoadLounge = await DJLounge.findOne({ loungeId: lobby.loungeId }).select('coordination.state.items coordination.outbox').lean();
  const queueLoadRows = allSuccessfulTrackIds.length
    ? await QueueEvent.find({ loungeId: lobby.loungeId, type: 'track.added', 'payload.trackId': { $in: allSuccessfulTrackIds } }).select('seq payload.trackId').lean()
    : [];
  const queueLoadIds = new Set((queueLoadLounge?.coordination?.state?.items ?? []).map((item) => item.trackId));
  const uniqueQueueLoadTrackIds = new Set(queueLoadRows.map((event) => event.payload.trackId));
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

async function runSegueLoad(lobby, iterations) {
  const acknowledgement = [];
  const announcementLatency = [];
  const failed = [];
  for (let index = 0; index < iterations; index += 1) {
    const host = lobby.hosts[index % lobby.hosts.length];
    const peerHost = lobby.hosts.find((entry) => entry.instance !== host.instance);
    const startedAt = performance.now();
    const announced = waitForEvent(peerHost.socket, 'lounge.ai.dj_announcement', (message) => message?.loungeId === lobby.loungeId, 10000);
    const [trigger] = await Promise.all([
      socketCommand(host.socket, 'lounge.ai.segue.trigger', { currentTs: 170 }, 15000),
    ]);
    if (!trigger.response?.ok || !trigger.response.decision?.selectedTrackId) {
      failed.push(trigger.response?.error?.code ?? (trigger.timedOut ? 'ACK_TIMEOUT' : 'NO_SEGUE'));
      await announced.catch(() => {});
      continue;
    }
    acknowledgement.push(trigger.latencyMs);
    try {
      const event = await announced;
      announcementLatency.push(Number((event.at - startedAt).toFixed(3)));
    } catch { failed.push('ANNOUNCEMENT_TIMEOUT'); }
    const ended = await socketCommand(host.socket, 'lounge.playback.ended', { trackId: trigger.response.decision.currentTrackId ?? (await DJLounge.findOne({ loungeId: lobby.loungeId }).select('currentTrackId').lean()).currentTrackId }, 15000);
    // The trigger response does not repeat the source ID in all versions; query it before transition below if needed.
    if (!ended.response?.ok) {
      const saved = await DJLounge.findOne({ loungeId: lobby.loungeId }).select('currentTrackId pendingSegue.fromTrackId').lean();
      if (saved?.pendingSegue?.fromTrackId) {
        const retry = await socketCommand(host.socket, 'lounge.playback.ended', { trackId: saved.pendingSegue.fromTrackId }, 15000);
        if (!retry.response?.ok) failed.push(retry.response?.error?.code ?? 'TRANSITION_FAILED');
      } else failed.push(ended.response?.error?.code ?? 'TRANSITION_FAILED');
    }
  }
  return { samplesRequested: iterations, preparationAck: summarize(acknowledgement), socketAnnouncementFromTrigger: summarize(announcementLatency), failed };
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
  assertSafeTestMongoUri(configuredUri);
  const { uri: mongoUri, databaseName } = createIsolatedMongoTestDatabase(configuredUri, 'runtimebench');
  const benchmarkWallStarted = performance.now();
  const benchmarkWallStartedAt = new Date();
  let connected = false;
  let processes = [];
  const clients = [];
  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const topology = await mongoose.connection.db.admin().command({ hello: 1 });
    const buildInfo = await mongoose.connection.db.admin().command({ buildInfo: 1 });
    const now = new Date();
    const loungeId = `lg_${crypto.randomBytes(8).toString('hex')}`;
    const inviteCode = `SP-${crypto.randomBytes(2).toString('hex').toUpperCase().replace(/[01]/g, 'A')}`;
    const hostId = new mongoose.Types.ObjectId();
    const coDjIds = Array.from({ length: 25 }, () => new mongoose.Types.ObjectId());
    const listenerIds = Array.from({ length: 24 }, () => new mongoose.Types.ObjectId());
    const allIds = [hostId, ...coDjIds, ...listenerIds];
    const users = allIds.map((id, index) => ({
      _id: id, email: `perf-${String(id)}@example.invalid`, displayName: `Benchmark ${index}`,
      passwordHash: 'unused-benchmark-only-value', role: index === 0 ? 'Host' : index <= coDjIds.length ? 'Co-DJ' : 'Listener',
    }));
    const currentTrackId = 't_perf_current';
    const segueTrackIds = Array.from({ length: segueSamples + 10 }, (_, index) => `t_perf_seg_${String(index).padStart(3, '0')}`);
    const addTrackIds = Array.from({ length: queueSamplesPerLevel * queueConcurrencyLevels.length + 30 }, (_, index) => `t_perf_add_${String(index).padStart(5, '0')}`);
    const battleTrackIds = ['t_perf_battle_a', 't_perf_battle_b'];
    const stageTrackIds = Array.from({ length: 10 }, (_, index) => `t_perf_stage_${String(index).padStart(3, '0')}`);
    const tracks = [
      makeTrack(currentTrackId, 'Current fixture'),
      ...segueTrackIds.map((trackId, index) => makeTrack(trackId, `Segue ${String(index).padStart(3, '0')}`, { key: index % 2 ? '9A' : '8A' })),
      ...addTrackIds.map((trackId, index) => makeTrack(trackId, `Queue Add ${String(index).padStart(5, '0')}`, { key: index % 2 ? '9A' : '8A' })),
      ...stageTrackIds.map((trackId, index) => makeTrack(trackId, `Outbox Stage ${index}`)),
      ...battleTrackIds.map((trackId, index) => makeTrack(trackId, `Soundclash Candidate ${index}`, { key: index ? '9A' : '8A' })),
    ];
    const seededQueue = [currentTrackId, ...segueTrackIds];
    await Promise.all([User.init(), Track.init(), DJLounge.init(), QueueEvent.init()]);
    await User.create(users);
    await Track.create(tracks);
    await DJLounge.create({
      loungeId, inviteCode, hostUserId: hostId, vibeProfile: 'Isolated performance workload',
      queue: seededQueue, currentTrackId, status: 'live', participantIds: allIds,
      createdAt: now, startedAt: now, analyticsTrackingVersion: 1, sessionEventSeq: 0,
      settings: { maxParticipants: 50, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });

    const ports = [await reservePort(), await reservePort()];
    for (const port of ports) processes.push(await startApiProcess(port, mongoUri));
    const clientEntries = [];
    const addClientEntry = (id, role, instance, ordinal) => {
      const entry = { key: `${String(id)}:${instance}:${ordinal}`, userId: String(id), role, instance, token: makeToken(id), socket: null };
      clientEntries.push(entry);
    };
    addClientEntry(hostId, 'Host', 0, 0);
    addClientEntry(hostId, 'Host', 1, 1);
    coDjIds.forEach((id, index) => addClientEntry(id, 'Co-DJ', index % 2, 0));
    listenerIds.forEach((id, index) => addClientEntry(id, 'Listener', index % 2, 0));
    const lobby = { loungeId, inviteCode, clients: clientEntries, queueWaiters: new Map() };
    for (const entry of clientEntries) {
      const socket = connectClient(entry, processes, lobby);
      clients.push(socket);
    }
    await Promise.all(clientEntries.map(async (entry) => {
      await waitForConnect(entry.socket);
      const joined = await socketCommand(entry.socket, 'lounge.join', { inviteCode }, 20000);
      if (!joined.response?.ok) throw new Error(`Benchmark client join failed: ${joined.response?.error?.code ?? 'UNKNOWN_ERROR'}`);
    }));
    const writers = clientEntries.filter((entry) => entry.role === 'Co-DJ');
    const hosts = clientEntries.filter((entry) => entry.role === 'Host');
    const listeners = clientEntries.filter((entry) => entry.role === 'Listener');
    lobby.writers = writers;
    lobby.hosts = hosts;

    const apiLoad = [];
    for (let index = 0; index < warmupSamples; index += 1) {
      const response = await fetch(`${processes[index % 2].origin}/api/v1/tracks?limit=10`);
      if (!response.ok) throw new Error(`API warm-up returned ${response.status}`);
    }
    for (const concurrency of apiConcurrencyLevels) {
      const measured = await Promise.all(processes.map((processInfo) => requestLoad(processInfo.origin, apiSamples, concurrency)));
      apiLoad.push({
        concurrencyPerProcess: concurrency,
        samplesPerProcess: apiSamples,
        metricsByProcess: measured,
        totalRequests: apiSamples * processes.length,
        note: 'Each process received an independent sample batch; warm-up requests are excluded from reported statistics.',
      });
    }

    const queueLoad = await runQueueLoad(lobby, queueConcurrencyLevels, queueSamplesPerLevel);

    const outboxStages = [];
    for (const [index, trackId] of stageTrackIds.entries()) {
      const writer = writers[index % writers.length];
      const started = performance.now();
      const command = socketCommand(writer.socket, 'lounge.queue.add', { trackId }, 20000);
      let commitObservedAt = null;
      let projectionObservedAt = null;
      let acknowledgementObservedAt = null;
      const deadline = started + 10000;
      while (performance.now() < deadline && acknowledgementObservedAt === null) {
        const lounge = await DJLounge.findOne({ loungeId }).select('coordination').lean();
        const stateHasTrack = lounge?.coordination?.state?.items?.some((item) => item.trackId === trackId);
        if (stateHasTrack && commitObservedAt === null) commitObservedAt = performance.now();
        const projected = await QueueEvent.exists({ loungeId, type: 'track.added', 'payload.trackId': trackId });
        if (projected && projectionObservedAt === null) projectionObservedAt = performance.now();
        const pending = lounge?.coordination?.outbox?.some((event) => event.payload?.trackId === trackId);
        if (projected && !pending) acknowledgementObservedAt = performance.now();
        if (!acknowledgementObservedAt) await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const result = await command;
      if (!result.response?.ok) throw new Error(`Outbox timing mutation failed: ${result.response?.error?.code ?? 'ACK_TIMEOUT'}`);
      outboxStages.push({
        commandAckMs: result.latencyMs,
        commitObservedAfterSendMs: commitObservedAt === null ? null : Number((commitObservedAt - started).toFixed(3)),
        projectionObservedAfterCommitMs: projectionObservedAt === null || commitObservedAt === null ? null : Number((projectionObservedAt - commitObservedAt).toFixed(3)),
        acknowledgementObservedAfterProjectionMs: acknowledgementObservedAt === null || projectionObservedAt === null ? null : Number((acknowledgementObservedAt - projectionObservedAt).toFixed(3)),
        observationIntervalMs: 1,
      });
    }

    const segue = await runSegueLoad(lobby, segueSamples);

    const firstSubmit = listeners[0];
    const secondSubmit = listeners[1];
    const submitA = await socketCommand(firstSubmit.socket, 'lounge.soundclash.submit', { trackId: battleTrackIds[0] });
    if (!submitA.response?.ok) throw new Error(`Soundclash first submission failed: ${submitA.response?.error?.code}`);
    const submitB = await socketCommand(secondSubmit.socket, 'lounge.soundclash.submit', { trackId: battleTrackIds[1] });
    if (!submitB.response?.ok) throw new Error(`Soundclash second submission failed: ${submitB.response?.error?.code}`);
    const opened = await socketCommand(hosts[0].socket, 'lounge.sync.request', {});
    const battleId = opened.response?.state?.soundclash?.battleId;
    if (!battleId || opened.response.state.soundclash.status !== 'open') throw new Error('Soundclash failed to reach the open state');
    const voteLatencies = [];
    const voteStarted = performance.now();
    const voteReplies = await Promise.all(Array.from({ length: soundclashVoteCount }, (_, index) =>
      socketCommand(listeners[index].socket, 'lounge.soundclash.vote', { battleId, trackId: battleTrackIds[index % 2] }, 30000)));
    for (const reply of voteReplies) {
      if (reply.response?.ok) voteLatencies.push(reply.latencyMs);
    }
    const finalVoteCount = await QueueEvent.countDocuments({ loungeId, type: 'soundclash.voted', 'payload.battleId': battleId });
    const finalVoteLatency = Number((performance.now() - voteStarted).toFixed(3));
    if (finalVoteCount !== voteLatencies.length) throw new Error('Soundclash vote acknowledgements did not reconcile with persisted votes');
    const tieNotification = waitForEvent(hosts[0].socket, 'lounge.soundclash.vote', (message) => message?.loungeId === loungeId && message.payload?.status === 'tied', 45000);
    const battleDoc = await DJLounge.findOne({ loungeId }).select('coordination.state.soundclash').lean();
    const closeAt = new Date(battleDoc.coordination.state.soundclash.closesAt).getTime();
    const closeDelayMs = Math.max(0, closeAt - Date.now());
    const tieWaitStarted = performance.now();
    const tieWaitMs = closeDelayMs + 10000;
    const tiedResult = await Promise.race([tieNotification, new Promise((resolve) => setTimeout(() => resolve(null), tieWaitMs))]);
    if (!tiedResult) throw new Error('Timed Soundclash did not recover and close voting at its stored deadline');
    const resolveStarted = performance.now();
    const resolvedEvent = waitForEvent(secondSubmit.socket, 'lounge.soundclash.resolved', (message) => message?.loungeId === loungeId && message.payload?.battleId === battleId, 15000);
    const resolution = await socketCommand(hosts[0].socket, 'lounge.soundclash.resolve', { battleId, winningTrackId: battleTrackIds[0] }, 15000);
    if (!resolution.response?.ok) throw new Error(`Soundclash resolution failed: ${resolution.response?.error?.code ?? 'UNKNOWN_ERROR'}`);
    const resolutionBroadcast = await resolvedEvent;
    const soundclashResult = {
      concurrentVoters: soundclashVoteCount,
      successfulVotes: voteLatencies.length,
      voteAckLatency: summarize(voteLatencies),
      concurrentVoteWaveMs: finalVoteLatency,
      voteFanoutFromDeadlineMs: Number((tiedResult.at - (tieWaitStarted + closeDelayMs)).toFixed(3)),
      tiedResolutionAckMs: resolution.latencyMs,
      resolutionBroadcastFromCommandMs: Number((resolutionBroadcast.at - resolveStarted).toFixed(3)),
      resolutionEventCount: await QueueEvent.countDocuments({ loungeId, type: 'soundclash.resolved', 'payload.battleId': battleId }),
      resolvedPersisted: (await DJLounge.findOne({ loungeId }).select('coordination.state.soundclash.status').lean()).coordination.state.soundclash.status === 'resolved',
    };

    const recovery = await recoveryAfterRestart(processes, lobby, mongoUri);
    const totalQueueEvents = await QueueEvent.countDocuments({ loungeId });
    const finalLounge = await DJLounge.findOne({ loungeId }).select('coordination.revision coordination.state.items coordination.outbox').lean();
    const finalQueueAddedRows = queueLoad.allSuccessfulTrackIds.length
      ? await QueueEvent.find({ loungeId, type: 'track.added', 'payload.trackId': { $in: queueLoad.allSuccessfulTrackIds } }).select('seq payload.trackId').lean()
      : [];
    const queueStateTrackIds = new Set((finalLounge?.coordination?.state?.items ?? []).map((item) => item.trackId));
    const report = {
      benchmark: 'AstraDJ runtime performance and coordination benchmark',
      generatedAt: new Date().toISOString(),
      durationMs: Number((performance.now() - benchmarkWallStarted).toFixed(3)),
      startedAt: benchmarkWallStartedAt.toISOString(),
      commit: '9be5cce',
      database: { topology: topology.setName ? 'replicaSet' : (topology.msg === 'isdbgrid' ? 'mongos' : 'standalone'), version: buildInfo.version, hostScope: 'loopback only', databaseName, cleanup: 'unique astradj_test_runtimebench_<random> database dropped after report writing' },
      runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, cpuModel: os.cpus()[0]?.model ?? 'unknown', logicalCpuCount: os.cpus().length, totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(2)), apiProcessCount: 2, apiProcessStartupMs: processes.map((processInfo) => processInfo.startupMs), roomCapacityAccounts: 50, socketConnections: clientEntries.length, hostConnectionsAcrossProcesses: 2 },
      methodology: { apiEndpoint: 'GET /api/v1/tracks?limit=10', apiConcurrencyLevels, apiSamplesPerProcessPerLevel: apiSamples, queueConcurrencyLevels, queueSamplesPerLevel, soundclashVoteCount, segueSamples, warmupSamplesPerApiProcess: warmupSamples, percentileMethod: 'nearest-rank; p95/p99 precision depends on reported sample count', audioPlayback: 'not used; segue lifecycle initiated by authenticated Socket.io currentTs and ended commands, so this is service/network timing, not browser playback latency', clientLocation: 'same machine, loopback TCP/WebSocket', syntheticDataOnly: true },
      prdTargets: { nonAiApiP95Ms: 200, segueDecisionP95Ms: 3000, queueStateSyncDriftMs: 100, roomFanoutFromServerReceiptMs: 500, queueDesignCapacity: 50 },
      apiCatalogRead: apiLoad,
      queueMutation: queueLoad.levels,
      outboxStageObservations: {
        samples: outboxStages.length,
        observationIntervalMs: 1,
        commitObservedAfterSend: summarize(outboxStages.map((sample) => sample.commitObservedAfterSendMs).filter(Number.isFinite)),
        projectionObservedAfterCommit: summarize(outboxStages.map((sample) => sample.projectionObservedAfterCommitMs).filter(Number.isFinite)),
        acknowledgementObservedAfterProjection: summarize(outboxStages.map((sample) => sample.acknowledgementObservedAfterProjectionMs).filter(Number.isFinite)),
        measurements: outboxStages,
        note: 'Commit/projection/ack timings are observed by polling the actual Mongo documents from a separate test client; each is an upper-bound observation with up to one polling interval plus query time, not internal span instrumentation.',
      },
      segue: { ...segue, note: 'Authenticated two-process Socket.io request and committed announcement observed by the peer process; no browser media or accelerated playback. The sample is a service decision proxy, not the PRD browser-rendered boundary-to-script measurement.' },
      soundclash: soundclashResult,
      recovery,
      correctness: { queueAddedSamples: queueLoad.levels.reduce((sum, row) => sum + row.attempted, 0), queueMutationErrors: queueLoad.levels.reduce((sum, row) => sum + row.errors, 0), queueLoadReconciliation: queueLoad.queueLoadReconciliation, finalQueueAddedEventRows: finalQueueAddedRows.length, finalQueueStateItems: queueStateTrackIds.size, totalQueueEvents, queueStateItems: finalLounge?.coordination?.state?.items?.length ?? 0, outboxBacklogAtEnd: finalLounge?.coordination?.outbox?.length ?? null, databaseIsolated: true },
      interpretation: { productionClaim: false, note: 'Local MongoDB and loopback tests do not establish cloud/network performance or production capacity. PRD targets are only verified for the measured local workload when sample size and measurement boundaries are adequate; all small-sample or proxy metrics must remain unverified.' },
    };
    const outputPath = fileURLToPath(new URL('../../docs/performance-benchmark-2026-10-26.json', import.meta.url));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const socket of clients) socket.disconnect();
    for (const processInfo of processes) await stopApiProcess(processInfo);
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}

main().catch((error) => {
  const safeMessage = String(error.message).replaceAll(configuredUri ?? '', '[test Mongo URI]').replaceAll(benchmarkSecret, '[benchmark JWT secret]');
  console.error(`Runtime benchmark failed safely: ${safeMessage}`);
  process.exitCode = 1;
});
