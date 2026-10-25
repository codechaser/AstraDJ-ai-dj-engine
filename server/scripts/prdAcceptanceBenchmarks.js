import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as createClient } from 'socket.io-client';
import { rankSegueCandidates } from '../src/services/acousticMatcher.js';
import { bucketSentiment } from '../src/services/roomSentimentService.js';
import { sentimentLabeledDataset } from '../tests/fixtures/sentimentLabeledDataset.js';
import { sentimentHeldoutDataset } from '../tests/fixtures/sentimentHeldoutDataset.js';
import { baselineLexiconClassifier, evaluateClassifier, frozenCurrentSentimentClassifier } from './sentimentEvaluation.js';
import { sentimentDevelopmentDataset } from '../tests/fixtures/sentimentDevelopmentDataset.js';
import { sentimentIndependentHeldoutDataset } from '../tests/fixtures/sentimentIndependentHeldoutDataset.js';
import { runMultiProfileRecommendationEvaluation } from '../src/services/recommendationEvaluation.js';
import { createSegueService } from '../src/services/segueService.js';
import { createQueueService } from '../src/services/queueService.js';
import { attachLoungeGateway } from '../src/socket/loungeGateway.js';

const labels = ['positive', 'neutral', 'negative'];
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const acousticTrack = (trackId, bpm, camelotKey, energy = 0.5, valence = 0.5) => ({
  trackId, title: trackId, artist: 'Benchmark fixture', durationSeconds: 120,
  acoustic: { bpm, camelotKey, energy, valence }, timeline: [{ ts: 10, type: 'trivia', text: 'Synthetic benchmark timeline fact.' }],
});

function evaluateAcousticDecisions() {
  const validKeys = ['12A', '11A', '1A', '12B'];
  let invalidSelections = 0;
  let weightErrors = 0;
  const decisions = 20;
  for (let index = 0; index < decisions; index += 1) {
    const current = acousticTrack(`current-${index}`, 120 + index % 6, '12A', 0.2 + (index % 5) * 0.15);
    const valid = acousticTrack(`valid-${index}`, current.acoustic.bpm * [1, 0.5, 2][index % 3], validKeys[index % validKeys.length], 0.1 + (index % 8) * 0.1);
    const ranked = rankSegueCandidates(current, [
      valid,
      acousticTrack(`bad-bpm-${index}`, 90, '12A'),
      acousticTrack(`bad-key-${index}`, current.acoustic.bpm, '9B'),
      acousticTrack(`missing-${index}`, current.acoustic.bpm, '13A'),
    ], { currentSentimentScore: (index % 11) / 10 });
    const selected = ranked.eligible[0];
    const incompatibleCandidateIds = [`bad-bpm-${index}`, `bad-key-${index}`, `missing-${index}`];
    const compatibleSelection = selected?.track.trackId === valid.trackId
      && selected.match.bpmDeltaPct <= 8
      && ['same', 'adjacent', 'relative'].includes(selected.match.camelotRelation)
      && incompatibleCandidateIds.every((trackId) => ranked.rejected.some((item) => item.track.trackId === trackId));
    if (!compatibleSelection) invalidSelections += 1;
    if (selected && Math.abs(selected.match.score - (0.5 * selected.match.harmonicCloseness + 0.3 * selected.match.energyFit + 0.2 * selected.match.recencyScore)) > 0.0001) weightErrors += 1;
  }
  return { decisions, invalidSelections, compliancePercent: (decisions - invalidSelections) / decisions * 100, weightErrors };
}

function evaluateSentiment() {
  const countByLabel = (dataset) => Object.fromEntries(labels.map((label) => [label, dataset.filter((entry) => entry.label === label).length]));
  const legacyBaseline = evaluateClassifier(sentimentLabeledDataset, baselineLexiconClassifier);
  const legacyCurrent = evaluateClassifier(sentimentLabeledDataset, bucketSentiment);
  const heldoutBaseline = evaluateClassifier(sentimentHeldoutDataset, baselineLexiconClassifier);
  const heldoutFinal = evaluateClassifier(sentimentHeldoutDataset, bucketSentiment);
  return {
    language: 'English and Hinglish transliteration',
    PRDTargetPercent: 85,
    legacyLexiconAwareDiagnostic: {
      datasetSize: sentimentLabeledDataset.length,
      classBalance: countByLabel(sentimentLabeledDataset),
      origin: 'synthetic and manually labeled after reviewing the original lexicon; diagnostic/regression fixture, not independent validation',
      originalBaseline: legacyBaseline,
      currentClassifier: legacyCurrent,
    },
    separatelyAuthoredEvaluation: {
      datasetSize: sentimentHeldoutDataset.length,
      classBalance: countByLabel(sentimentHeldoutDataset),
      origin: 'developer-authored synthetic English examples labeled before scoring; one-shot held-out evaluation, not real-user data',
      labelingGuide: 'docs/sentiment-evaluation.md',
      baselineBeforeRuleChanges: heldoutBaseline,
      frozenClassifier: heldoutFinal,
      meetsTarget: heldoutFinal.accuracy >= 0.85,
      limitation: 'Small synthetic evaluation set; accuracy does not establish production or real-user performance.',
    },
    independent2026Evaluation: {
      datasetSize: sentimentIndependentHeldoutDataset.length,
      classBalance: countByLabel(sentimentIndependentHeldoutDataset),
      fixtureSha256: createHash('sha256').update(readFileSync(new URL('../tests/fixtures/sentimentIndependentHeldoutDataset.js', import.meta.url))).digest('hex'),
      origin: 'developer-authored synthetic English/Hinglish examples, manually labeled before classifier changes; not real-user data',
      labelingGuide: 'docs/sentiment-evaluation.md',
      developmentSetSize: sentimentDevelopmentDataset.length,
      developmentBaseline: evaluateClassifier(sentimentDevelopmentDataset, frozenCurrentSentimentClassifier),
      developmentUpdated: evaluateClassifier(sentimentDevelopmentDataset, bucketSentiment),
      preChangeFrozenClassifier: evaluateClassifier(sentimentIndependentHeldoutDataset, frozenCurrentSentimentClassifier),
      updatedClassifier: evaluateClassifier(sentimentIndependentHeldoutDataset, bucketSentiment),
      meetsTarget: evaluateClassifier(sentimentIndependentHeldoutDataset, bucketSentiment).accuracy >= 0.85,
      limitation: 'One small synthetic one-author holdout; useful for regression discovery, not representative production accuracy evidence.',
    },
  };
}

class Query {
  constructor(value) { this.value = value; }
  select() { return this; }
  lean() { return Promise.resolve(this.value); }
}

async function measureSegueService(iterations = 250) {
  const current = acousticTrack('t_current', 124, '8A', 0.6, 0.6);
  const next = acousticTrack('t_next', 128, '9A', 0.62, 0.62);
  const lounge = { loungeId: 'lg_benchmark1234', status: 'live', currentTrackId: 't_current', participantIds: ['benchmark-user'], settings: { bpmTolerancePct: 8 } };
  const service = createSegueService({
    loungeModel: { findOne: () => new Query(lounge) },
    trackModel: {
      findOne: () => new Query(current),
      find: () => new Query([next]),
    },
    sentimentService: { snapshot: () => ({ rollingScore: 0.5, windowSeconds: 300, sampleSize: 0 }) },
  });
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    const response = await service.requestSegue({ loungeId: lounge.loungeId, userId: 'benchmark-user', input: { currentTrackId: current.trackId, currentTs: 100, candidateTrackIds: [next.trackId], currentSentimentScore: 0.5, recentTrackIds: [] } });
    durations.push(performance.now() - start);
    if (response.selectedTrackId !== next.trackId) throw new Error('Segue benchmark unexpectedly failed to select the eligible fixture track');
  }
  return { iterations, timing: 'in-process service wall time; fake repository; deterministic fallback; excludes MongoDB, socket transport and an outro scheduler', p50Ms: Number(percentile(durations, 0.5).toFixed(3)), p95Ms: Number(percentile(durations, 0.95).toFixed(3)), maxMs: Number(Math.max(...durations).toFixed(3)) };
}

function connectAndJoin(socket, inviteCode) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 10000);
    socket.once('connect_error', (error) => { clearTimeout(timeout); reject(error); });
    const joined = () => socket.emit('lounge.join', { inviteCode }, (result) => {
      if (!result?.ok) { clearTimeout(timeout); reject(new Error(`Join rejected: ${result?.error?.code ?? 'unknown'}`)); }
      else { clearTimeout(timeout); resolve(result); }
    });
    if (socket.connected) joined(); else socket.once('connect', joined);
  });
}

function queueCommand(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 5000);
    socket.emit(event, payload, (result) => { clearTimeout(timeout); result?.ok ? resolve(result) : reject(new Error(`${event} rejected: ${result?.error?.code ?? 'unknown'}`)); });
  });
}

async function measureFiftyParticipantQueue({ rounds = 20, participantCount = 50 } = {}) {
  const secret = 'local-prd-benchmark-secret-32chars-minimum';
  const loungeId = 'lg_benchmark1234';
  const inviteCode = 'SP-9X2L';
  const userIds = Array.from({ length: participantCount }, (_, index) => (index + 1).toString(16).padStart(24, '0'));
  const users = new Map(userIds.map((id, index) => [id, { _id: id, id, displayName: `Simulated ${index + 1}`, role: index === 0 ? 'Host' : 'Listener' }]));
  const trackMap = new Map([['t_2001', { trackId: 't_2001', title: 'Current', artist: 'Benchmark', durationSeconds: 120 }]]);
  for (let index = 0; index < rounds; index += 1) trackMap.set(`t_bench_${String(index).padStart(3, '0')}`, { trackId: `t_bench_${String(index).padStart(3, '0')}`, title: `Queue ${index}`, artist: 'Benchmark', durationSeconds: 120 });
  const lounge = { loungeId, inviteCode, hostUserId: userIds[0], status: 'live', currentTrackId: 't_2001', queue: ['t_2001'], participantIds: [], settings: { maxParticipants: participantCount } };
  const events = [];
  const repository = {
    async findLoungeByInvite(code) { return code.toUpperCase() === inviteCode ? lounge : null; },
    async findLoungeById(id) { return id === loungeId ? lounge : null; },
    async joinLounge(candidate, userId) { if (!candidate.participantIds.includes(userId)) candidate.participantIds.push(userId); return candidate; },
    async listQueueEvents(id) { return events.filter((event) => event.loungeId === id); },
    async appendQueueEvents(batch) { events.push(...structuredClone(batch)); },
    async getTrack(id) { return trackMap.get(id) ?? null; },
    async getUser(id) { return users.get(String(id)) ?? null; },
  };
  const server = createServer();
  const ioServer = new Server(server, { transports: ['websocket'] });
  const queueService = createQueueService(repository, { voteFlushMs: 30000 });
  const chatService = { flushAll: async () => {} };
  const metricService = { recordPresence: async () => {} };
  const soundclashService = { snapshot: async () => null, close: () => {} };
  attachLoungeGateway(ioServer, { repository, queueService, secret, soundclashService, chatService, loungeMetricEventService: metricService, loungeLifecycleService: {} });
  const sockets = [];
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const [index, userId] of userIds.entries()) {
      const token = jwt.sign({}, secret, { subject: userId, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
      sockets.push(createClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 10000 }));
    }
    await Promise.all(sockets.map((socket, index) => connectAndJoin(socket, inviteCode).then((result) => {
      if (!result.state?.loungeId) throw new Error(`Participant ${index} received no Lounge snapshot`);
    })));

    const driftSamples = [];
    const fanoutSamples = [];
    for (let round = 0; round < rounds; round += 1) {
      const arrivals = [];
      const eventPromises = sockets.map((socket) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('lounge.queue.update', onUpdate); reject(new Error('Queue update fan-out timed out')); }, 5000);
        function onUpdate(message) {
          if (message?.loungeId !== loungeId || message.payload?.reason !== 'add') return;
          arrivals.push(performance.now());
          clearTimeout(timer);
          socket.off('lounge.queue.update', onUpdate);
          resolve(message);
        }
        socket.on('lounge.queue.update', onUpdate);
      }));
      const started = performance.now();
      const ackPromise = queueCommand(sockets[0], 'lounge.queue.add', { trackId: `t_bench_${String(round).padStart(3, '0')}` });
      const [ack, ...updates] = await Promise.all([ackPromise, ...eventPromises]);
      if (updates.length !== participantCount || updates.some((update) => JSON.stringify(update.payload.queue) !== JSON.stringify(updates[0].payload.queue)) || !ack.state) {
        throw new Error(`Round ${round} clients did not observe an identical queue state`);
      }
      driftSamples.push(Math.max(...arrivals) - Math.min(...arrivals));
      fanoutSamples.push(Math.max(...arrivals) - started);
    }
    const summary = (values) => ({ p50Ms: Number(percentile(values, 0.5).toFixed(3)), p95Ms: Number(percentile(values, 0.95).toFixed(3)), maxMs: Number(Math.max(...values).toFixed(3)) });
    return { participants: participantCount, rounds, environment: 'single local Node process, localhost WebSocket clients, in-memory repository; synthetic simulated users', queueStateDriftMs: summary(driftSamples), fanoutFromCommandStartMs: summary(fanoutSamples), allClientsSawIdenticalState: true };
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await queueService.flushAll();
    await new Promise((resolve) => ioServer.close(resolve));
  }
}

const result = {
  acousticCompatibility: evaluateAcousticDecisions(),
  sentiment: evaluateSentiment(),
  recommendation: await runMultiProfileRecommendationEvaluation(),
  segueLatency: await measureSegueService(),
  socketQueueLoad: await measureFiftyParticipantQueue(),
};
console.log(JSON.stringify(result, null, 2));
