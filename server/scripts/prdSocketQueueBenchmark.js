import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as createClient } from 'socket.io-client';
import { attachLoungeGateway } from '../src/socket/loungeGateway.js';
import { createQueueService } from '../src/services/queueService.js';
import { queueStateHash } from '../src/services/queueAcceptanceTrace.js';
import { rateLimitPolicies } from '../src/config/rateLimitPolicy.js';
import { createMemoryRateLimiter } from '../tests/support/memoryRateLimiter.js';

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

function queueTrackIds(state) {
  return [
    ...(state?.nowPlaying?.trackId ? [state.nowPlaying.trackId] : []),
    ...(state?.nextUp ?? []).map(({ trackId }) => trackId),
  ];
}

function stateHashIsValid(revision, trackIds, stateHash) {
  return Number.isSafeInteger(revision)
    && typeof stateHash === 'string'
    && queueStateHash(revision, trackIds) === stateHash;
}

function connectAndJoin(socket, inviteCode, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('connect_error', onError);
      socket.off('connect', onConnect);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Socket connection timed out'));
    }, timeoutMs);
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onConnect = () => {
      socket.emit('lounge.join', { inviteCode }, (result) => {
        cleanup();
        result?.ok ? resolve(result) : reject(new Error('Join rejected: ' + (result?.error?.code ?? 'unknown')));
      });
    };
    socket.once('connect_error', onError);
    if (socket.connected) onConnect();
    else socket.once('connect', onConnect);
  });
}

function observeTrace(socket, loungeId, traceId, timeoutMs) {
  let count = 0;
  let firstMessage = null;
  let firstAt = null;
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const timer = setTimeout(() => resolveFirst(null), timeoutMs);
  const onUpdate = (message) => {
    if (message?.loungeId !== loungeId || message.payload?.acceptanceTrace?.traceId !== traceId) return;
    count += 1;
    if (count === 1) {
      firstMessage = message;
      firstAt = performance.now();
      resolveFirst(message);
    }
  };
  socket.on('lounge.queue.update', onUpdate);
  return {
    first,
    get count() { return count; },
    get message() { return firstMessage; },
    get receivedAt() { return firstAt; },
    cleanup() {
      clearTimeout(timer);
      socket.off('lounge.queue.update', onUpdate);
      resolveFirst(null);
    },
  };
}

function sendQueueCommand(socket, payload, timeoutMs) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ response: null, roundTripMs: Number((performance.now() - startedAt).toFixed(3)), timedOut: true });
    }, timeoutMs);
    socket.emit('lounge.queue.add', payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ response, roundTripMs: Number((performance.now() - startedAt).toFixed(3)), timedOut: false });
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

export async function measureFiftyParticipantQueue({
  rounds = 20,
  participantCount = 50,
  rateLimiter = createMemoryRateLimiter(),
  connectionTimeoutMs = 10_000,
  acknowledgementTimeoutMs = 5_000,
} = {}) {
  if (!Number.isInteger(rounds) || rounds < 1) throw new TypeError('rounds must be a positive integer');
  if (!Number.isInteger(participantCount) || participantCount < 2 || participantCount > 50) {
    throw new TypeError('participantCount must be an integer from 2 to 50');
  }
  const requiredWriters = Math.ceil(rounds / rateLimitPolicies.queueAdd.limit);
  if (requiredWriters > participantCount) {
    throw new RangeError('The participant count is too small to stay within the configured per-user queue rate limit');
  }
  if (!rateLimiter || typeof rateLimiter.consume !== 'function') throw new TypeError('A rate limiter dependency is required');

  const secret = 'local-prd-benchmark-secret-32chars-minimum';
  const loungeId = 'lg_benchmark1234';
  const inviteCode = 'SP-9X2L';
  const userIds = Array.from({ length: participantCount }, (_, index) => (index + 1).toString(16).padStart(24, '0'));
  const writerSocketIndexes = Array.from({ length: requiredWriters }, (_, index) => index);
  const users = new Map(userIds.map((id, index) => [id, {
    _id: id,
    id,
    displayName: 'Simulated ' + (index + 1),
    role: index === 0 ? 'Host' : index < requiredWriters ? 'Co-DJ' : 'Listener',
  }]));
  const trackMap = new Map([['t_2001', { trackId: 't_2001', title: 'Current', artist: 'Benchmark', durationSeconds: 120 }]]);
  for (let index = 0; index < rounds; index += 1) {
    const trackId = 't_bench_' + String(index).padStart(3, '0');
    trackMap.set(trackId, { trackId, title: 'Queue ' + index, artist: 'Benchmark', durationSeconds: 120 });
  }
  const lounge = {
    loungeId, inviteCode, hostUserId: userIds[0], status: 'live', currentTrackId: 't_2001',
    queue: ['t_2001'], participantIds: [], settings: { maxParticipants: participantCount },
  };
  const events = [];
  const repository = {
    async findLoungeByInvite(code) { return code.toUpperCase() === inviteCode ? lounge : null; },
    async findLoungeById(id) { return id === loungeId ? lounge : null; },
    async joinLounge(candidate, userId) {
      if (!candidate.participantIds.includes(userId)) candidate.participantIds.push(userId);
      return candidate;
    },
    async listQueueEvents(id) { return events.filter((event) => event.loungeId === id); },
    async appendQueueEvents(batch) { events.push(...structuredClone(batch)); },
    async getTrack(id) { return trackMap.get(id) ?? null; },
    async getUser(id) { return users.get(String(id)) ?? null; },
  };
  const server = createServer();
  const ioServer = new Server(server, { transports: ['websocket'] });
  const queueService = createQueueService(repository, { voteFlushMs: 30_000 });
  const chatService = { flushAll: async () => {} };
  const metricService = { recordPresence: async () => {} };
  const soundclashService = { snapshot: async () => null, close: () => {} };
  const previousTraceSetting = process.env.ASTRA_LOUNGE_ACCEPTANCE_TRACE;
  process.env.ASTRA_LOUNGE_ACCEPTANCE_TRACE = 'true';
  const gateway = attachLoungeGateway(ioServer, {
    repository, queueService, secret, rateLimiter, soundclashService, chatService,
    loungeMetricEventService: metricService, loungeLifecycleService: {},
  });
  const sockets = [];
  const measurements = [];
  const clientReceiptCounts = new Map(userIds.map((id) => [id, 0]));
  const clientQueueSnapshots = new Map(userIds.map((id) => [id, null]));
  const clientLastRevision = new Map(userIds.map((id) => [id, 0]));
  const eventObservations = [];
  const startedAt = performance.now();
  const cpuStarted = process.cpuUsage();
  const memoryStarted = process.memoryUsage();
  let serverStarted = false;
  try {
    await listen(server);
    serverStarted = true;
    const url = 'http://127.0.0.1:' + server.address().port;
    for (const userId of userIds) {
      const token = jwt.sign({}, secret, { subject: userId, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
      const socket = createClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: connectionTimeoutMs });
      socket.on('lounge.queue.update', (message) => {
        if (message?.loungeId !== loungeId) return;
        const revision = message.payload?.revision;
        const queueIds = (message.payload?.queue ?? []).map(({ trackId }) => trackId);
        clientReceiptCounts.set(userId, clientReceiptCounts.get(userId) + 1);
        clientQueueSnapshots.set(userId, queueIds);
        if (Number.isSafeInteger(revision)) {
          if (revision < clientLastRevision.get(userId)) eventObservations.push({ userId, revision, outOfOrder: true });
          clientLastRevision.set(userId, Math.max(clientLastRevision.get(userId), revision));
        }
      });
      sockets.push(socket);
    }
    const joins = await Promise.all(sockets.map((socket) => connectAndJoin(socket, inviteCode, connectionTimeoutMs)));
    if (joins.some((result) => result.state?.loungeId !== loungeId)) throw new Error('A simulated participant did not receive the expected Lounge snapshot');

    const syncDriftSamples = [];
    const lastClientReceiptSamples = [];
    const commandRoundTripSamples = [];
    const serverProcessingSamples = [];
    let mutationRejections = 0;
    let mutationTimeouts = 0;
    let missingClientReceipts = 0;
    let duplicateClientReceipts = 0;
    let queueStateDivergences = 0;
    let queueStateHashComparisons = 0;
    let queueStateHashMismatches = 0;
    let outOfOrderClientReceipts = 0;
    let mutationAcknowledgements = 0;

    for (let round = 0; round < rounds; round += 1) {
      const trackId = 't_bench_' + String(round).padStart(3, '0');
      const traceId = randomUUID();
      const observations = sockets.map((socket) => observeTrace(socket, loungeId, traceId, acknowledgementTimeoutMs));
      const started = performance.now();
      const command = await sendQueueCommand(
        sockets[writerSocketIndexes[round % writerSocketIndexes.length]],
        { trackId, acceptanceTraceId: traceId },
        acknowledgementTimeoutMs,
      );
      const response = command.response;
      if (command.timedOut) mutationTimeouts += 1;
      if (response?.ok === true) mutationAcknowledgements += 1;
      else mutationRejections += 1;
      commandRoundTripSamples.push(command.roundTripMs);

      if (response?.ok !== true) {
        for (const observation of observations) observation.cleanup();
        measurements.push({ round, trackId, accepted: false, timedOut: command.timedOut, errorCode: response?.error?.code ?? 'ACK_TIMEOUT' });
        continue;
      }
      const updates = await Promise.all(observations.map((observation) => observation.first));
      await new Promise((resolve) => setImmediate(resolve));
      const trace = response.acceptanceTrace;
      if (Number.isFinite(trace?.serverProcessingMs)) serverProcessingSamples.push(trace.serverProcessingMs);
      const received = updates.filter(Boolean);
      missingClientReceipts += participantCount - received.length;
      const roundDuplicates = observations.reduce((sum, observation) => sum + Math.max(0, observation.count - 1), 0);
      duplicateClientReceipts += roundDuplicates;
      const responseTrackIds = queueTrackIds(response.state);
      const responseHash = queueStateHash(response.state.revision, responseTrackIds);
      const validUpdates = [];
      let roundHashMismatches = 0;
      for (const message of received) {
        const revision = message.payload?.revision;
        const ids = (message.payload?.queue ?? []).map(({ trackId: id }) => id);
        queueStateHashComparisons += 1;
        const hashValid = stateHashIsValid(revision, ids, message.payload?.stateHash)
          && revision === response.state.revision
          && message.payload.stateHash === responseHash
          && JSON.stringify(ids) === JSON.stringify(responseTrackIds);
        if (!hashValid) {
          queueStateHashMismatches += 1;
          roundHashMismatches += 1;
        } else validUpdates.push(message);
      }
      queueStateDivergences += (participantCount - received.length) + roundHashMismatches;
      const arrivals = observations.map((observation) => observation.receivedAt).filter(Number.isFinite);
      if (arrivals.length) syncDriftSamples.push(Math.max(...arrivals) - Math.min(...arrivals));
      if (Number.isFinite(trace?.serverReceivedAtMonoMs) && arrivals.length) {
        lastClientReceiptSamples.push(Math.max(...arrivals) - trace.serverReceivedAtMonoMs);
      }
      outOfOrderClientReceipts += eventObservations.length;
      eventObservations.length = 0;
      measurements.push({
        round, trackId, accepted: true, expectedClients: participantCount, receivedClients: received.length,
        duplicateReceipts: roundDuplicates,
        queueRevision: response.state.revision, queueHashMatchesAcrossClients: validUpdates.length === participantCount,
        serverProcessingMs: trace?.serverProcessingMs ?? null,
        serverReceiptToLastClientReceiptMs: Number.isFinite(trace?.serverReceivedAtMonoMs) && arrivals.length
          ? Number((Math.max(...arrivals) - trace.serverReceivedAtMonoMs).toFixed(3)) : null,
        commandStartToLastClientReceiptMs: arrivals.length ? Number((Math.max(...arrivals) - started).toFixed(3)) : null,
      });
      for (const observation of observations) observation.cleanup();
    }

    await new Promise((resolve) => setImmediate(resolve));
    const finalState = await queueService.snapshot(lounge);
    const finalTrackIds = queueTrackIds(finalState);
    const finalStateHash = queueStateHash(finalState.revision, finalTrackIds);
    const finalClientDivergences = [...clientQueueSnapshots.values()]
      .filter((snapshot) => !snapshot || JSON.stringify(snapshot) !== JSON.stringify(finalTrackIds)).length;
    queueStateDivergences += finalClientDivergences;
    const logicalEvents = events.filter((event) => event.type === 'track.added');
    const successfulTrackIds = measurements.filter((row) => row.accepted).map((row) => row.trackId);
    const missingServerEvents = successfulTrackIds.filter((id) => !logicalEvents.some((event) => event.payload?.trackId === id)).length;
    const duplicateLogicalEvents = logicalEvents.length - new Set(logicalEvents.map((event) => event.payload?.trackId)).size;
    const expectedFinalTrackIds = ['t_2001', ...successfulTrackIds];
    const missingFinalQueueItems = successfulTrackIds.filter((id) => !finalTrackIds.includes(id)).length;
    const finalQueueMatchesExpectedOrder = JSON.stringify(finalTrackIds) === JSON.stringify(expectedFinalTrackIds);
    const summary = (values) => values.length ? {
      samples: values.length,
      p50Ms: Number(percentile(values, 0.5).toFixed(3)),
      p95Ms: Number(percentile(values, 0.95).toFixed(3)),
      p99Ms: Number(percentile(values, 0.99).toFixed(3)),
      maxMs: Number(Math.max(...values).toFixed(3)),
    } : { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
    const cpuUsed = process.cpuUsage(cpuStarted);
    const memoryEnded = process.memoryUsage();
    const accepted = measurements.filter((row) => row.accepted).length;
    const expectedReceipts = accepted * participantCount;
    const observedReceipts = expectedReceipts - missingClientReceipts;
    const correctnessPassed = mutationRejections === 0
      && mutationTimeouts === 0
      && missingClientReceipts === 0
      && duplicateClientReceipts === 0
      && outOfOrderClientReceipts === 0
      && queueStateHashMismatches === 0
      && missingServerEvents === 0
      && duplicateLogicalEvents === 0
      && missingFinalQueueItems === 0
      && finalClientDivergences === 0
      && finalQueueMatchesExpectedOrder;

    return {
      status: correctnessPassed ? 'PASS_LOCAL_SYNTHETIC_ONLY' : 'FAIL_LOCAL_SYNTHETIC',
      loungeCount: 1,
      participants: participantCount,
      rounds,
      mutationAttempts: rounds,
      successfulMutations: accepted,
      acknowledgedMutations: mutationAcknowledgements,
      rejectedMutations: mutationRejections,
      mutationTimeouts,
      serverRecordedQueueEvents: logicalEvents.length,
      missingServerEvents,
      duplicateLogicalEvents,
      expectedClientReceipts: expectedReceipts,
      observedClientReceipts: observedReceipts,
      rawClientQueueUpdateReceipts: [...clientReceiptCounts.values()].reduce((sum, count) => sum + count, 0),
      missingClientReceipts,
      duplicateClientReceipts,
      queueStateHashComparisons,
      queueStateHashMismatches,
      queueStateDivergences,
      outOfOrderClientReceipts,
      finalClientDivergences,
      finalQueue: {
        revision: finalState.revision,
        trackCount: finalTrackIds.length,
        stateHash: finalStateHash,
        missingQueueItems: missingFinalQueueItems,
        matchesExpectedOrder: finalQueueMatchesExpectedOrder,
      },
      latencyMs: {
        clientArrivalSpread: summary(syncDriftSamples),
        serverReceiptToLastClientReceipt: summary(lastClientReceiptSamples),
        commandStartToLastClientReceipt: summary(measurements.map((row) => row.commandStartToLastClientReceiptMs).filter(Number.isFinite)),
        commandAcknowledgementRoundTrip: summary(commandRoundTripSamples),
        serverProcessing: summary(serverProcessingSamples),
      },
      environment: {
        topology: 'one Node process, one Lounge, authenticated localhost Socket.IO WebSocket clients, in-memory queue repository; no MongoDB or browser rendering',
        runtime: process.version,
        platform: process.platform + '-' + process.arch,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        durationMs: Number((performance.now() - startedAt).toFixed(3)),
        cpuUserMs: Number((cpuUsed.user / 1000).toFixed(3)),
        cpuSystemMs: Number((cpuUsed.system / 1000).toFixed(3)),
        memoryStartBytes: memoryStarted.rss,
        memoryEndBytes: memoryEnded.rss,
        rateLimiter: 'In-memory fixed-window test dependency enforces the same configured policies; production Mongo rate limiter is unchanged.',
        rateLimitChecks: Number.isInteger(rateLimiter.calls) ? rateLimiter.calls : null,
        writerRoles: [...new Set(writerSocketIndexes.map((index) => users.get(userIds[index]).role))],
      },
      workloadNotes: 'Queue writes are sequential within the single Lounge. This measures local Socket.IO receipt spread, not concurrent multi-process, MongoDB, or rendered UI synchronization.',
      perRound: measurements,
    };
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    try { await gateway.close(); } finally {
      await new Promise((resolve) => ioServer.close(resolve));
      if (previousTraceSetting === undefined) delete process.env.ASTRA_LOUNGE_ACCEPTANCE_TRACE;
      else process.env.ASTRA_LOUNGE_ACCEPTANCE_TRACE = previousTraceSetting;
    }
  }
}
