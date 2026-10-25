import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as createClient } from 'socket.io-client';
import { attachLoungeGateway } from '../src/socket/loungeGateway.js';
import { createQueueService } from '../src/services/queueService.js';
import { createRoomSentimentService } from '../src/services/roomSentimentService.js';
import { createSoundclashService } from '../src/services/soundclashService.js';
import { rankSegueCandidates } from '../src/services/acousticMatcher.js';

const secret = 'test-secret-astradj-only-32-characters';
const uidHost = '507f1f77bcf86cd799439011';
const uidListener = '507f1f77bcf86cd799439012';
const uidListener2 = '507f1f77bcf86cd799439013';
const uidListener3 = '507f1f77bcf86cd799439014';
const uidCoDj = '507f1f77bcf86cd799439015';
const uidAdmin = '507f1f77bcf86cd799439016';
const users = new Map([
  [uidHost, { _id: uidHost, displayName: 'Host', role: 'Host' }],
  [uidListener, { _id: uidListener, displayName: 'Listener', role: 'Listener' }],
  [uidListener2, { _id: uidListener2, displayName: 'Guest Two', role: 'Listener' }],
  [uidListener3, { _id: uidListener3, displayName: 'Guest Three', role: 'Listener' }],
  [uidCoDj, { _id: uidCoDj, displayName: 'Co DJ', role: 'Co-DJ' }],
  [uidAdmin, { _id: uidAdmin, displayName: 'Admin', role: 'Admin' }],
]);
const trackData = new Map([
  ['t_2001', { trackId: 't_2001', title: 'Night Drive', artist: 'Nova Circuit', durationSeconds: 220, acoustic: { bpm: 120, camelotKey: '8A', energy: 0.7, valence: 0.6 } }],
  ['t_2002', { trackId: 't_2002', title: 'Neon Tide', artist: 'Nova Circuit', durationSeconds: 210, acoustic: { bpm: 121, camelotKey: '8A', energy: 0.68, valence: 0.6 } }],
  ['t_2003', { trackId: 't_2003', title: 'Afterglow', artist: 'Mira Vale', durationSeconds: 205 }],
  ['t_2004', { trackId: 't_2004', title: 'Blue Hour', artist: 'Mira Vale', durationSeconds: 208 }],
  ['t_2005', { trackId: 't_2005', title: 'Slow Lights', artist: 'June North', durationSeconds: 215 }],
]);
const hostId = uidHost;

function makeRepository() {
  const lounges = new Map([['lg_123456789abc', {
    loungeId: 'lg_123456789abc', inviteCode: 'SP-9X2L', hostUserId: hostId,
    participantIds: [uidHost], queue: ['t_2001'], currentTrackId: 't_2001', status: 'live',
    settings: { maxParticipants: 3 },
  }]]);
  const events = [];
  return {
    lounges,
    events,
    async findLoungeByInvite(code) { return [...lounges.values()].find((lounge) => lounge.inviteCode === code.toUpperCase() && lounge.status !== 'ended') ?? null; },
    async findLoungeById(id) { return lounges.get(id) ?? null; },
    async joinLounge(lounge, userId) {
      if (lounge.status === 'ended') return null;
      if (lounge.participantIds.includes(userId)) return lounge;
      if (lounge.participantIds.length >= lounge.settings.maxParticipants) return null;
      lounge.participantIds.push(userId);
      return lounge;
    },
    async listQueueEvents(loungeId) { return events.filter((event) => event.loungeId === loungeId).sort((a, b) => a.seq - b.seq); },
    async appendQueueEvents(batch) { if (this.failQueueAppend) throw new Error('simulated persistence failure'); events.push(...structuredClone(batch)); },
    async getTrack(trackId) { return trackData.get(trackId) ?? null; },
    async setCurrentTrack(loungeId, currentTrackId) { const lounge = lounges.get(loungeId); if (lounge?.status !== 'live') return null; lounge.currentTrackId = currentTrackId; delete lounge.pendingSegue; return lounge; },
    async setPendingSegue(loungeId, fromTrackId, pendingSegue) { const lounge = lounges.get(loungeId); if (lounge?.status !== 'live' || lounge.currentTrackId !== fromTrackId) return null; lounge.pendingSegue = structuredClone(pendingSegue); return lounge; },
    async clearPendingSegue(loungeId, fromTrackId) { const lounge = lounges.get(loungeId); if (lounge?.pendingSegue?.fromTrackId === fromTrackId) delete lounge.pendingSegue; return lounge; },
    async getTrackMetadata(trackId) { const track = trackData.get(trackId); return track ? { ...track, timeline: [{ ts: 12, type: 'trivia', text: `${track.title} is from the sample catalog.` }] } : null; },
    async getUser(id) { return users.get(String(id)) ?? null; },
    async appendChatMessages(batch) { this.chatMessages ??= []; this.chatMessages.push(...structuredClone(batch)); },
    async listRecentChatMessages(loungeId, limit) { return (this.chatMessages ?? []).filter((message) => message.loungeId === loungeId).slice(-limit); },
  };
}

function token(userId) {
  return jwt.sign({}, secret, { subject: userId, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
}
function connect(userId, opts = {}) {
  const authToken = Object.hasOwn(opts, 'token') ? opts.token : token(userId);
  return createClient(`http://127.0.0.1:${port}`, { auth: { token: authToken }, transports: ['websocket'], reconnection: false, timeout: 1200 });
}
function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`Timed out waiting for ${event}`)); }, 2000);
    function onEvent(data) { clearTimeout(timer); resolve(data); }
    socket.once(event, onEvent);
  });
}
function waitForMatch(socket, event, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`Timed out waiting for matching ${event}`)); }, 2000);
    function onEvent(data) {
      if (!predicate(data)) return;
      clearTimeout(timer); socket.off(event, onEvent); resolve(data);
    }
    socket.on(event, onEvent);
  });
}
async function connected(socket) {
  if (socket.connected) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Connection timeout (connected=${socket.connected}, port=${port})`)), 1800);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}
function command(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ack timeout for ${event}, connected=${socket.connected}`)), 1800);
    socket.emit(event, payload, (value) => { clearTimeout(timer); resolve(value); });
  });
}
async function join(socket) {
  await connected(socket);
  return command(socket, 'lounge.join', { inviteCode: 'SP-9X2L' });
}

let server;
let ioServer;
let port;
let repository;
let queueService;
let chatService;
let sentimentService;
let soundclashService;
let publishAnnouncement;
let loungeLifecycleService;
let loungeMetricEventService;
let sockets;
let segueRequests;

beforeEach(async () => {
  repository = makeRepository();
  loungeLifecycleService = {
    async end({ loungeId, userId }) {
      const lounge = repository.lounges.get(loungeId);
      if (String(lounge.hostUserId) !== String(userId)) throw Object.assign(new Error('Only the Lounge Host can end this session'), { status: 403, code: 'LOUNGE_HOST_REQUIRED' });
      if (lounge.status === 'ended') return { lounge, alreadyEnded: true };
      lounge.status = 'ended'; lounge.endedAt = new Date();
      lounge.sessionSummary = { durationSeconds: 120, queueEventCount: 0, soundclashBattles: 0, chatMessageCount: 0, sentimentTimeline: [], peakConcurrentParticipants: null, aiDjQuestionCount: null };
      return { lounge, alreadyEnded: false };
    },
  };
  queueService = createQueueService(repository, { voteFlushMs: 30_000 });
  sentimentService = createRoomSentimentService();
  segueRequests = 0;
  loungeMetricEventService = { events: [], async recordPresence(event) { this.events.push(structuredClone(event)); } };
  const segueService = { async requestSegue({ input }) {
    segueRequests += 1;
    const currentTrack = trackData.get(input.currentTrackId);
    const ranked = rankSegueCandidates(currentTrack, input.candidateTrackIds.map((trackId) => trackData.get(trackId)).filter(Boolean));
    const selected = ranked.eligible[0];
    return { selectedTrackId: selected?.track.trackId ?? null, matchReason: selected?.match ?? null, transitionScript: selected ? `${currentTrack.title} flows into ${selected.track.title}.` : null, sourceEvents: selected ? [`track:${currentTrack.trackId}:metadata`, `track:${selected.track.trackId}:metadata`] : [], provider: 'deterministic-template' };
  } };
  server = createServer();
  ioServer = new Server(server, { transports: ['websocket'] });
  ({ chatService, soundclashService, publishAnnouncement } = attachLoungeGateway(ioServer, { repository, queueService, secret, sentimentService, loungeLifecycleService, loungeMetricEventService, segueService, soundclashOptions: { voteDurationMs: 160 } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  sockets = [];
});
afterEach(async () => {
  await chatService.flushAll();
  soundclashService.close();
  await queueService.flushAll();
  for (const socket of sockets) socket.disconnect();
  await new Promise((resolve) => ioServer.close(resolve));
});
function client(userId, opts) { const socket = connect(userId, opts); sockets.push(socket); return socket; }

test('authenticated Host and Listener join the invite-authorized Lounge', async () => {
  const host = client(uidHost); const listener = client(uidListener);
  const h = await join(host); const l = await join(listener);
  expect(h.ok).toBe(true); expect(l.ok).toBe(true);
  expect(l.state.nowPlaying.trackId).toBe('t_2001');
  expect(l.state.hostDisconnected).toBe(false);
});

test('outro segue is selected in the configured playback window and queue advances only after actual ended signal', async () => {
  const host = client(uidHost); const listener = client(uidListener); const coDj = client(uidCoDj); const admin = client(uidAdmin);
  repository.lounges.get('lg_123456789abc').settings.maxParticipants = 5;
  await Promise.all([join(host), join(listener), join(coDj), join(admin)]);
  expect((await command(host, 'lounge.queue.add', { trackId: 't_2002' })).ok).toBe(true);
  const unauthorized = await command(listener, 'lounge.ai.segue.trigger', { currentTs: 209 });
  expect(unauthorized.error.code).toBe('LOUNGE_HOST_REQUIRED');
  expect((await command(coDj, 'lounge.ai.segue.trigger', { currentTs: 209 })).error.code).toBe('LOUNGE_HOST_REQUIRED');
  expect((await command(admin, 'lounge.ai.segue.trigger', { currentTs: 209 })).error.code).toBe('LOUNGE_HOST_REQUIRED');
  expect((await command(host, 'lounge.ai.segue.trigger', { currentTs: 100 })).error.code).toBe('OUTRO_WINDOW_NOT_REACHED');
  expect((await command(host, 'lounge.ai.segue.trigger', { currentTs: 220.1 })).error.code).toBe('VALIDATION_ERROR');
  expect((await command(host, 'lounge.ai.segue.trigger', { currentTs: 207.99 })).error.code).toBe('OUTRO_WINDOW_NOT_REACHED');
  const [ready, duplicate] = await Promise.all([
    command(host, 'lounge.ai.segue.trigger', { currentTs: 208 }),
    command(host, 'lounge.ai.segue.trigger', { currentTs: 209 }),
  ]);
  expect(ready).toMatchObject({ ok: true, decision: { selectedTrackId: 't_2002' }, outroWindowSeconds: 12 });
  expect(repository.lounges.get('lg_123456789abc').pendingSegue).toMatchObject({ fromTrackId: 't_2001', trackId: 't_2002' });
  expect(duplicate).toMatchObject({ ok: true, duplicate: true, decision: { selectedTrackId: 't_2002' } });
  expect(segueRequests).toBe(1);
  expect(repository.lounges.get('lg_123456789abc').currentTrackId).toBe('t_2001');
  const hostUpdate = waitForMatch(host, 'lounge.queue.update', (event) => event.payload?.reason === 'segue');
  const listenerUpdate = waitForMatch(listener, 'lounge.queue.update', (event) => event.payload?.reason === 'segue');
  const ended = await command(host, 'lounge.playback.ended', { trackId: 't_2001' });
  expect(ended.ok).toBe(true);
  const [hostEvent, listenerEvent] = await Promise.all([hostUpdate, listenerUpdate]);
  expect(hostEvent).toEqual(listenerEvent);
  expect(hostEvent.payload.transition.trackId).toBe('t_2002');
  expect(repository.lounges.get('lg_123456789abc').currentTrackId).toBe('t_2002');
  expect(repository.events.at(-1)).toMatchObject({ type: 'track.transitioned', payload: { fromTrackId: 't_2001', trackId: 't_2002' } });
  expect((await command(host, 'lounge.playback.ended', { trackId: 't_2001' })).error.code).toBe('SEGUE_NOT_PENDING');
});

test('outro preparation rejects unknown duration and an empty upcoming queue', async () => {
  const host = client(uidHost);
  await join(host);
  trackData.get('t_2001').durationSeconds = Number.NaN;
  expect((await command(host, 'lounge.ai.segue.trigger', { currentTs: 209 })).error.code).toBe('TRACK_DURATION_UNAVAILABLE');
  trackData.get('t_2001').durationSeconds = 220;
  expect(await command(host, 'lounge.ai.segue.trigger', { currentTs: 208 })).toMatchObject({ ok: true, noCompatibleCandidate: true });
  expect(repository.lounges.get('lg_123456789abc').pendingSegue).toBeUndefined();
});

test('outro preparation does not schedule a queued track with an unavailable acoustic profile', async () => {
  const host = client(uidHost);
  await join(host);
  await command(host, 'lounge.queue.add', { trackId: 't_2003' });
  const result = await command(host, 'lounge.ai.segue.trigger', { currentTs: 208 });
  expect(result).toMatchObject({ ok: true, noCompatibleCandidate: true });
  expect(repository.lounges.get('lg_123456789abc').pendingSegue).toBeUndefined();
  expect(segueRequests).toBe(1);
});

test('only the Host can cancel a persisted segue preparation', async () => {
  const host = client(uidHost); const listener = client(uidListener);
  await Promise.all([join(host), join(listener)]);
  await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  expect((await command(host, 'lounge.ai.segue.trigger', { currentTs: 208 })).ok).toBe(true);
  expect((await command(listener, 'lounge.playback.cancel', { trackId: 't_2001' })).error.code).toBe('LOUNGE_HOST_REQUIRED');
  expect(repository.lounges.get('lg_123456789abc').pendingSegue.trackId).toBe('t_2002');
  expect((await command(host, 'lounge.playback.cancel', { trackId: 't_2001' })).ok).toBe(true);
  expect(repository.lounges.get('lg_123456789abc').pendingSegue).toBeUndefined();
  expect((await command(host, 'lounge.playback.ended', { trackId: 't_2001' })).error.code).toBe('SEGUE_NOT_PENDING');
});

test('Host disconnect clears an obsolete prepared decision and reconnect can schedule a fresh one', async () => {
  const host = client(uidHost);
  await join(host);
  await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  const prepared = await command(host, 'lounge.ai.segue.trigger', { currentTs: 208 });
  expect(prepared.ok).toBe(true);
  const savedDecision = repository.lounges.get('lg_123456789abc').pendingSegue;
  host.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(repository.lounges.get('lg_123456789abc').pendingSegue).toBeUndefined();
  const reconnectedHost = client(uidHost);
  await join(reconnectedHost);
  const restored = await command(reconnectedHost, 'lounge.ai.segue.trigger', { currentTs: 209 });
  expect(restored).toMatchObject({ ok: true, decision: { selectedTrackId: 't_2002' }, recovered: false });
  expect(segueRequests).toBe(2);
  expect(savedDecision.trackId).toBe('t_2002');
});

test('rejoining the same socket does not persist a duplicate participant join event', async () => {
  const host = client(uidHost);
  expect((await join(host)).ok).toBe(true);
  expect((await join(host)).ok).toBe(true);
  expect(loungeMetricEventService.events).toEqual([{ loungeId: 'lg_123456789abc', userId: uidHost, action: 'joined', participantCount: 1 }]);
});

test('Host ends once, participants receive an isolated lifecycle envelope, and ended Lounge mutations and joins are rejected', async () => {
  const host = client(uidHost); const listener = client(uidListener); const outsider = client(uidListener2);
  await Promise.all([join(host), join(listener)]);
  await command(outsider, 'lounge.join', { inviteCode: 'SP-8X2L' });
  const hostEnded = waitFor(host, 'lounge.session.ended');
  const listenerEnded = waitFor(listener, 'lounge.session.ended');
  const ended = await command(host, 'lounge.session.end', {});
  expect(ended).toMatchObject({ ok: true, alreadyEnded: false, summary: { durationSeconds: 120 } });
  const [hostEvent, listenerEvent] = await Promise.all([hostEnded, listenerEnded]);
  expect(hostEvent).toMatchObject({ event: 'lounge.session.ended', loungeId: 'lg_123456789abc', payload: { endedAt: expect.any(String), summary: { durationSeconds: 120 } }, ts: expect.any(Number) });
  expect(listenerEvent).toEqual(hostEvent);
  expect((await command(listener, 'lounge.session.end', {})).error.code).toBe('LOUNGE_HOST_REQUIRED');
  expect((await command(host, 'lounge.queue.add', { trackId: 't_2002' })).error.code).toBe('LOUNGE_ENDED');
  expect((await command(listener, 'lounge.queue.vote', { trackId: 't_2001', value: 1 })).error.code).toBe('LOUNGE_ENDED');
  expect((await command(listener, 'lounge.chat.message', { body: 'After the end' })).error.code).toBe('LOUNGE_ENDED');
  expect((await command(listener, 'lounge.soundclash.submit', { trackId: 't_2003' })).error.code).toBe('LOUNGE_ENDED');
  expect((await command(outsider, 'lounge.join', { inviteCode: 'SP-9X2L' })).error.code).toBe('LOUNGE_NOT_FOUND');
  expect((await command(host, 'lounge.session.end', {}))).toMatchObject({ ok: true, alreadyEnded: true });
  const duplicateEvent = new Promise((resolve) => host.once('lounge.session.ended', resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect(Promise.race([duplicateEvent, Promise.resolve('no-duplicate')])).resolves.toBe('no-duplicate');
  expect(repository.lounges.get('lg_123456789abc').status).toBe('ended');
});

test('segue announcements use the PRD event envelope and are isolated to the authorized Lounge room', async () => {
  repository.lounges.set('lg_223456789abc', {
    loungeId: 'lg_223456789abc', inviteCode: 'SP-8X2L', hostUserId: uidHost,
    participantIds: [uidHost], queue: ['t_2001'], currentTrackId: 't_2001', status: 'live', settings: { maxParticipants: 3 },
  });
  const host = client(uidHost); const listener = client(uidListener); const otherRoom = client(uidHost);
  const deliveredHost = waitFor(host, 'lounge.ai.dj_announcement');
  const deliveredListener = waitFor(listener, 'lounge.ai.dj_announcement');
  await join(host); await join(listener);
  await command(otherRoom, 'lounge.join', { inviteCode: 'SP-8X2L' });
  const foreign = new Promise((resolve) => otherRoom.once('lounge.ai.dj_announcement', resolve));
  const payload = { text: 'AstraDJ deterministic fallback.', relatedTrackId: 't_2002', sourceEvents: ['t_2001#acoustic.bpm', 't_2002#timeline[0]'] };
  publishAnnouncement('lg_123456789abc', payload);
  const events = await Promise.all([deliveredHost, deliveredListener]);
  expect(events[0]).toMatchObject({ event: 'lounge.ai.dj_announcement', loungeId: 'lg_123456789abc', payload, ts: expect.any(Number) });
  expect(events[1]).toEqual(events[0]);
  await expect(Promise.race([foreign, new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))])).resolves.toBe('timeout');
});

test('rejects malformed and unknown invite codes', async () => {
  const socket = client(uidListener); await connected(socket);
  expect((await command(socket, 'lounge.join', { inviteCode: 'SP-AAAA' })).error.code).toBe('LOUNGE_NOT_FOUND');
  expect((await command(socket, 'lounge.join', { inviteCode: 'not-an-invite' })).error.code).toBe('VALIDATION_ERROR');
});

test('listeners cannot add tracks but joined participants can vote', async () => {
  const host = client(uidHost); const listener = client(uidListener);
  await join(host); await join(listener);
  expect((await command(listener, 'lounge.queue.add', { trackId: 't_2002' })).error.code).toBe('FORBIDDEN');
  expect((await command(host, 'lounge.queue.add', { trackId: 't_2002' })).ok).toBe(true);
  expect((await command(listener, 'lounge.queue.vote', { trackId: 't_2002', value: 1 })).ok).toBe(true);
});

test('join receives the complete authoritative Now Playing and Next Up snapshot', async () => {
  const host = client(uidHost); const listener = client(uidListener);
  await join(host); await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  const result = await join(listener);
  expect(result.state).toMatchObject({ loungeId: 'lg_123456789abc', revision: 1, nowPlaying: { trackId: 't_2001' }, nextUp: [{ trackId: 't_2002', votes: 0 }] });
});

test('queue additions fan out the same update to all connected participants', async () => {
  const host = client(uidHost); const listener = client(uidListener);
  await join(host); await join(listener);
  const update = waitFor(listener, 'lounge.queue.update');
  const start = performance.now();
  const result = await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  const received = await update;
  const driftMs = performance.now() - start;
  expect(result.state.nextUp.map((track) => track.trackId)).toEqual(['t_2002']);
  expect(received).toMatchObject({ event: 'lounge.queue.update', loungeId: 'lg_123456789abc', payload: { reason: 'add', queue: [{ trackId: 't_2001', position: 0 }, { trackId: 't_2002', position: 1 }] } });
  expect(driftMs).toBeLessThan(100);
  console.info(`Measured local queue fan-out: ${driftMs.toFixed(2)} ms (2 connected clients, localhost WebSocket).`);
});

test('vote-driven ordering is server-owned and identical for every client', async () => {
  const host = client(uidHost); const a = client(uidListener); const b = client(uidListener2);
  await join(host); await join(a); await join(b);
  await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  await command(host, 'lounge.queue.add', { trackId: 't_2003' });
  const eventA = waitFor(a, 'lounge.queue.update'); const eventB = waitFor(b, 'lounge.queue.update');
  const [votedA, votedB] = await Promise.all([
    command(a, 'lounge.queue.vote', { trackId: 't_2003', value: 1 }),
    command(b, 'lounge.queue.vote', { trackId: 't_2003', value: 1 }),
  ]);
  const [updateA, updateB] = await Promise.all([eventA, eventB]);
  expect(votedA.state.nextUp.map((track) => track.trackId)).toEqual(['t_2003', 't_2002']);
  expect(votedB.state.nextUp.map((track) => track.trackId)).toEqual(['t_2003', 't_2002']);
  expect(updateA.payload.queue).toEqual(updateB.payload.queue);
});

test('concurrent votes serialize to one final order without lost votes', async () => {
  const host = client(uidHost); const a = client(uidListener); const b = client(uidListener2);
  await join(host); await join(a); await join(b);
  await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  await command(host, 'lounge.queue.add', { trackId: 't_2003' });
  await Promise.all([
    command(a, 'lounge.queue.vote', { trackId: 't_2002', value: 1 }),
    command(b, 'lounge.queue.vote', { trackId: 't_2003', value: 1 }),
  ]);
  const [snapshotA, snapshotB] = await Promise.all([
    command(a, 'lounge.sync.request', {}), command(b, 'lounge.sync.request', {}),
  ]);
  expect(snapshotA.state).toMatchObject({ revision: 4 });
  expect(snapshotA.state.nextUp).toEqual(snapshotB.state.nextUp);
  expect(snapshotA.state.nextUp.map((track) => track.trackId)).toEqual(['t_2002', 't_2003']);
});

test('commands cannot access a protected room without authorized Lounge membership', async () => {
  const socket = client(uidListener); await connected(socket);
  const result = await command(socket, 'lounge.queue.vote', { trackId: 't_2002', value: 1 });
  expect(result.error.code).toBe('LOUNGE_MEMBERSHIP_REQUIRED');
  expect((await command(socket, 'lounge.soundclash.submit', { trackId: 't_2003' })).error.code).toBe('LOUNGE_MEMBERSHIP_REQUIRED');
});

test('reconnection returns current state without duplicate participants or queue entries', async () => {
  const host = client(uidHost); const participant = client(uidListener);
  await join(host); await join(participant);
  await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  participant.disconnect();
  const start = performance.now();
  const reconnected = client(uidListener);
  const result = await join(reconnected);
  const joinMs = performance.now() - start;
  expect(result.state.revision).toBe(1);
  expect(result.state.nextUp.map((track) => track.trackId)).toEqual(['t_2002']);
  expect(result.state.presence.filter((member) => member.userId === uidListener)).toHaveLength(1);
  expect(joinMs).toBeLessThan(2000);
  console.info(`Measured local reconnect + full-state join: ${joinMs.toFixed(2)} ms (localhost WebSocket).`);
});

test('a fresh queue service replays compact persisted events after process state is lost', async () => {
  const host = client(uidHost); const listener = client(uidListener);
  await join(host); await join(listener);
  await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  await command(listener, 'lounge.queue.vote', { trackId: 't_2002', value: 1 });
  expect(repository.events).toHaveLength(1);
  await queueService.flush('lg_123456789abc');
  const recoveredService = createQueueService(repository, { voteFlushMs: 30_000 });
  const lounge = await repository.findLoungeById('lg_123456789abc');
  const recovered = await recoveredService.snapshot(lounge);
  expect(recovered).toMatchObject({ revision: 2, nowPlaying: { trackId: 't_2001' }, nextUp: [{ trackId: 't_2002', votes: 1 }] });
  expect(repository.events.every((event) => !Object.hasOwn(event.payload, 'queue'))).toBe(true);
});

test('Host disconnect freezes mutation until Host reconnects', async () => {
  const host = client(uidHost); const listener = client(uidListener);
  await join(host); await join(listener);
  host.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const frozen = await command(listener, 'lounge.queue.vote', { trackId: 't_2001', value: 1 });
  expect(frozen.error.code).toBe('HOST_DISCONNECTED');
  const rejoinedHost = client(uidHost); await join(rejoinedHost);
  expect((await command(rejoinedHost, 'lounge.queue.add', { trackId: 't_2002' })).ok).toBe(true);
});

test('rejects socket connections without a valid JWT', async () => {
  for (const suppliedToken of [undefined, 'not-a-jwt']) {
    const socket = client(uidListener, { token: suppliedToken });
    await expect(connected(socket)).rejects.toBeDefined();
  }
});

test('sync ping returns the PRD pong envelope and capacity is enforced', async () => {
  const host = client(uidHost); const a = client(uidListener); const b = client(uidListener2); const c = client(uidListener3);
  await join(host); await join(a); await join(b);
  const third = await join(c);
  expect(third.error.code).toBe('LOUNGE_FULL');
  const received = waitFor(host, 'lounge.sync.pong');
  const ping = await command(host, 'lounge.sync.ping', { clientSentAt: Date.now() });
  expect(ping.ok).toBe(true);
  expect(await received).toMatchObject({ event: 'lounge.sync.pong', payload: { clientSentAt: expect.any(Number), serverReceivedAt: expect.any(Number) } });
});

test('authenticated Lounge members send chat and receive exact PRD event envelopes', async () => {
  const host = client(uidHost); const listener = client(uidListener);
  await join(host); await join(listener);
  const msgEvent = waitFor(host, 'lounge.chat.message');
  const sentimentEvent = waitFor(host, 'lounge.sentiment.score');
  const ack = await command(listener, 'lounge.chat.message', { body: 'This set is amazing!' });
  const message = await msgEvent;
  const sentiment = await sentimentEvent;
  expect(ack).toMatchObject({ ok: true, message: { userId: uidListener, body: 'This set is amazing!', sentimentBucket: 'positive' } });
  expect(message).toMatchObject({ event: 'lounge.chat.message', loungeId: 'lg_123456789abc', payload: { messageId: expect.any(String), userId: uidListener, body: 'This set is amazing!', sentimentBucket: 'positive', tsSeconds: expect.any(Number) }, ts: expect.any(Number) });
  expect(Object.keys(message.payload).sort()).toEqual(['body', 'messageId', 'sentimentBucket', 'tsSeconds', 'userId']);
  expect(sentiment).toMatchObject({ event: 'lounge.sentiment.score', loungeId: 'lg_123456789abc', payload: { rollingScore: 1, windowSeconds: 300, sampleSize: 1 }, ts: expect.any(Number) });
});

test('chat requires membership and rejects malformed, empty, overlong, and rate-limited messages', async () => {
  const outsider = client(uidListener); await connected(outsider);
  expect((await command(outsider, 'lounge.chat.message', { body: 'hello' })).error.code).toBe('LOUNGE_MEMBERSHIP_REQUIRED');
  const host = client(uidHost); const member = client(uidListener);
  await join(host); await join(member);
  for (const payload of [{ body: '' }, { body: 4 }, { body: 'x'.repeat(501) }, { body: '<b></b>' }, { body: 'hello', userId: uidHost }]) {
    expect((await command(member, 'lounge.chat.message', payload)).error.code).toBe('VALIDATION_ERROR');
  }
  for (let i = 0; i < 5; i++) expect((await command(member, 'lounge.chat.message', { body: `hello ${i}` })).ok).toBe(true);
  expect((await command(member, 'lounge.chat.message', { body: 'sixth' })).error.code).toBe('CHAT_RATE_LIMITED');
});

test('sanitizes HTML-like markup before storing and broadcasting user text', async () => {
  const host = client(uidHost); const member = client(uidListener);
  await join(host); await join(member);
  const result = await command(member, 'lounge.chat.message', { body: '<script>alert</script> good music' });
  expect(result.message.body).toBe('alert good music');
  expect(result.message.body).not.toContain('<');
});

test('chat broadcasts stay isolated to the joined Lounge and history is membership protected', async () => {
  repository.lounges.set('lg_223456789abc', { loungeId: 'lg_223456789abc', inviteCode: 'SP-8X2L', hostUserId: uidHost, participantIds: [uidHost], queue: ['t_2001'], currentTrackId: 't_2001', status: 'live', settings: { maxParticipants: 3 } });
  const host = client(uidHost); const member = client(uidListener); const secondHost = client(uidHost);
  await join(host); await join(member);
  await command(secondHost, 'lounge.join', { inviteCode: 'SP-8X2L' });
  const otherRoomMessage = new Promise((resolve) => secondHost.once('lounge.chat.message', resolve));
  const result = await command(member, 'lounge.chat.message', { body: 'good vibes' });
  expect(result.ok).toBe(true);
  await expect(Promise.race([otherRoomMessage, new Promise((resolve) => setTimeout(() => resolve('timeout'), 60))])).resolves.toBe('timeout');
  const history = await command(member, 'lounge.chat.history', { limit: 10 });
  expect(history.messages).toHaveLength(1);
  expect(history.messages[0]).toMatchObject({ body: 'good vibes', userId: uidListener, sentimentBucket: 'positive' });
  const noMembership = client(uidListener2); await connected(noMembership);
  expect((await command(noMembership, 'lounge.chat.history', {})).error.code).toBe('LOUNGE_MEMBERSHIP_REQUIRED');
});

test('all four authorized roles may chat as joined users and concurrent posts retain every score', async () => {
  repository.lounges.get('lg_123456789abc').settings.maxParticipants = 5;
  const host = client(uidHost); const listener = client(uidListener); const coDj = client(uidCoDj); const admin = client(uidAdmin);
  await Promise.all([join(host), join(listener), join(coDj), join(admin)]);
  const socketsToChat = [[host, 'mid tempo session'], [listener, 'love it'], [coDj, 'good groove'], [admin, 'this is awful']];
  const results = await Promise.all(socketsToChat.map(([socket, body]) => command(socket, 'lounge.chat.message', { body })));
  expect(results.every((result) => result.ok)).toBe(true);
  expect(sentimentService.snapshot('lg_123456789abc')).toMatchObject({ sampleSize: 4, rollingScore: 0.625 });
});

async function setupSoundclash({ includeCoDj = false } = {}) {
  if (includeCoDj) repository.lounges.get('lg_123456789abc').settings.maxParticipants = 4;
  const host = client(uidHost); const a = client(uidListener); const b = client(uidListener2);
  await Promise.all([join(host), join(a), join(b)]);
  let coDj;
  if (includeCoDj) { coDj = client(uidCoDj); await join(coDj); }
  await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  await command(a, 'lounge.queue.vote', { trackId: 't_2002', value: 1 });
  await command(b, 'lounge.queue.vote', { trackId: 't_2002', value: 1 });
  return { host, a, b, coDj };
}

test('Soundclash collects Listener submissions, opens with the exact PRD envelope, and inserts the timed winner at Next Up', async () => {
  const { host, a, b } = await setupSoundclash();
  expect((await command(host, 'lounge.soundclash.submit', { trackId: 't_2004' })).error.code).toBe('FORBIDDEN');
  const subA = await command(a, 'lounge.soundclash.submit', { trackId: 't_2003' });
  const subB = await command(b, 'lounge.soundclash.submit', { trackId: 't_2004' });
  expect(subA.ok && subB.ok).toBe(true);
  expect((await command(a, 'lounge.soundclash.submit', { trackId: 't_2005' })).error.code).toBe('SOUNDCLASH_ALREADY_SUBMITTED');
  const open = waitFor(host, 'lounge.soundclash.open');
  const opened = await command(host, 'lounge.soundclash.open', {});
  const openEvent = await open;
  expect(opened.ok).toBe(true);
  expect(openEvent).toMatchObject({ event: 'lounge.soundclash.open', loungeId: 'lg_123456789abc', payload: { battleId: subA.state.battleId, candidateTrackIds: ['t_2003', 't_2004'], closesAt: expect.any(Number) }, ts: expect.any(Number) });
  expect(Object.keys(openEvent.payload).sort()).toEqual(['battleId', 'candidateTrackIds', 'closesAt']);
  const queueUpdate = waitFor(host, 'lounge.queue.update');
  const announcement = waitFor(host, 'lounge.ai.dj_announcement');
  const resolution = waitFor(host, 'lounge.soundclash.resolved');
  const resolutionA = waitFor(a, 'lounge.soundclash.resolved');
  const resolutionB = waitFor(b, 'lounge.soundclash.resolved');
  expect((await command(a, 'lounge.soundclash.vote', { battleId: subA.state.battleId, trackId: 't_2003' })).ok).toBe(true);
  expect((await command(b, 'lounge.soundclash.vote', { battleId: subA.state.battleId, trackId: 't_2003' })).ok).toBe(true);
  const resolutionEvents = await Promise.all([resolution, resolutionA, resolutionB]);
  const resolvedEvent = resolutionEvents[0];
  expect(resolvedEvent).toMatchObject({ event: 'lounge.soundclash.resolved', loungeId: 'lg_123456789abc', payload: { battleId: subA.state.battleId, winningTrackId: 't_2003' }, ts: expect.any(Number) });
  expect(Object.keys(resolvedEvent.payload).sort()).toEqual(['battleId', 'winningTrackId']);
  expect(resolutionEvents[1]).toEqual(resolvedEvent);
  expect(resolutionEvents[2]).toEqual(resolvedEvent);
  expect(await queueUpdate).toMatchObject({ payload: { reason: 'battle', queue: [{ trackId: 't_2001', position: 0 }, { trackId: 't_2003', position: 1 }, { trackId: 't_2002', position: 2 }] } });
  expect(await announcement).toMatchObject({ payload: { relatedTrackId: 't_2003', sourceEvents: ['t_2003#timeline[0]'] } });
  expect((await announcement).payload.text).toContain('Afterglow is from the sample catalog.');
  const state = await command(a, 'lounge.sync.request', {});
  expect(state.state.nextUp.map((track) => track.trackId)).toEqual(['t_2003', 't_2002']);
  expect(state.state.soundclash).toMatchObject({ status: 'resolved', winningTrackId: 't_2003' });
});

test('tied Soundclash votes can be resolved only by Host or Co-DJ and only to a tied candidate', async () => {
  const { host, a, b, coDj } = await setupSoundclash({ includeCoDj: true });
  const first = await command(a, 'lounge.soundclash.submit', { trackId: 't_2003' });
  await command(b, 'lounge.soundclash.submit', { trackId: 't_2004' });
  await command(host, 'lounge.soundclash.open', {});
  const votes = await Promise.all([
    command(a, 'lounge.soundclash.vote', { battleId: first.state.battleId, trackId: 't_2003' }),
    command(b, 'lounge.soundclash.vote', { battleId: first.state.battleId, trackId: 't_2004' }),
  ]);
  expect(votes.every((vote) => vote.ok)).toBe(true);
  const tied = waitForMatch(host, 'lounge.soundclash.vote', (event) => event.payload?.status === 'tied');
  expect((await tied).payload.voteCounts).toEqual({ t_2003: 1, t_2004: 1 });
  users.get(uidListener).role = 'Admin';
  expect((await command(a, 'lounge.soundclash.resolve', { battleId: first.state.battleId, winningTrackId: 't_2003' })).error.code).toBe('FORBIDDEN');
  users.get(uidListener).role = 'Listener';
  expect((await command(a, 'lounge.soundclash.resolve', { battleId: first.state.battleId, winningTrackId: 't_2003' })).error.code).toBe('FORBIDDEN');
  expect((await command(coDj, 'lounge.soundclash.resolve', { battleId: first.state.battleId, winningTrackId: 't_2005' })).error.code).toBe('INVALID_TIE_WINNER');
  const resolved = waitFor(host, 'lounge.soundclash.resolved');
  const outcomes = await Promise.all([
    command(coDj, 'lounge.soundclash.resolve', { battleId: first.state.battleId, winningTrackId: 't_2004' }),
    command(coDj, 'lounge.soundclash.resolve', { battleId: first.state.battleId, winningTrackId: 't_2004' }),
  ]);
  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  expect(outcomes.filter((outcome) => !outcome.ok)[0].error.code).toBe('SOUNDCLASH_NOT_TIED');
  expect((await resolved).payload.winningTrackId).toBe('t_2004');
});

test('Soundclash validates membership, command payloads, candidate count, duplicate votes, and Lounge isolation', async () => {
  repository.lounges.set('lg_223456789abc', { loungeId: 'lg_223456789abc', inviteCode: 'SP-8X2L', hostUserId: uidHost, participantIds: [uidHost], queue: ['t_2001'], currentTrackId: 't_2001', status: 'live', settings: { maxParticipants: 3 } });
  const host = client(uidHost); const a = client(uidListener); const b = client(uidListener2); const otherRoom = client(uidHost);
  await Promise.all([join(host), join(a), join(b)]);
  await command(otherRoom, 'lounge.join', { inviteCode: 'SP-8X2L' });
  expect((await command(host, 'lounge.soundclash.submit', { trackId: 'bad', role: 'Host' })).error.code).toBe('VALIDATION_ERROR');
  expect((await command(a, 'lounge.soundclash.vote', { battleId: 'missing', trackId: 't_2003' })).error.code).toBe('SOUNDCLASH_NOT_FOUND');
  await command(host, 'lounge.queue.add', { trackId: 't_2002' });
  expect((await command(host, 'lounge.soundclash.open', {})).error.code).toBe('SOUNDCLASH_NOT_COLLECTING');
  const first = await command(a, 'lounge.soundclash.submit', { trackId: 't_2003' });
  await command(b, 'lounge.soundclash.submit', { trackId: 't_2004' });
  const foreignEvent = new Promise((resolve) => otherRoom.once('lounge.soundclash.open', resolve));
  await command(host, 'lounge.soundclash.open', {});
  // The event is only delivered to the authorized Lounge room.
  await expect(Promise.race([foreignEvent, new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))])).resolves.toBe('timeout');
  await command(a, 'lounge.soundclash.vote', { battleId: first.state.battleId, trackId: 't_2003' });
  expect((await command(a, 'lounge.soundclash.vote', { battleId: first.state.battleId, trackId: 't_2004' })).error.code).toBe('SOUNDCLASH_DUPLICATE_VOTE');
});

test('Soundclash restores an open battle and its server timer resolves after voters disconnect', async () => {
  const { host, a, b } = await setupSoundclash();
  const first = await command(a, 'lounge.soundclash.submit', { trackId: 't_2003' });
  await command(b, 'lounge.soundclash.submit', { trackId: 't_2004' });
  await command(host, 'lounge.soundclash.open', {});
  await command(a, 'lounge.soundclash.vote', { battleId: first.state.battleId, trackId: 't_2003' });
  await queueService.flush('lg_123456789abc');
  soundclashService.close();
  soundclashService = createSoundclashService({ repository, queueService, voteDurationMs: 40, onEvent: (event, loungeId, payload) => ioServer.to(`lounge:${loungeId}`).emit(event, { event, loungeId, payload, ts: Date.now() }) });
  const lounge = await repository.findLoungeById('lg_123456789abc');
  expect(await soundclashService.snapshot(lounge)).toMatchObject({ status: 'open', candidateTrackIds: ['t_2003', 't_2004'], voteCounts: { t_2003: 1, t_2004: 0 } });
  a.disconnect(); b.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 240));
  expect(await soundclashService.snapshot(lounge)).toMatchObject({ status: 'resolved', winningTrackId: 't_2003' });
});

test('Soundclash persistence failure does not publish or expose an uncommitted battle', async () => {
  const { a } = await setupSoundclash();
  await queueService.flush('lg_123456789abc');
  repository.failQueueAppend = true;
  const event = new Promise((resolve) => a.once('lounge.soundclash.submission', resolve));
  const failed = await command(a, 'lounge.soundclash.submit', { trackId: 't_2003' });
  expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed' } });
  expect((await command(a, 'lounge.sync.request', {})).state.soundclash).toMatchObject({ status: 'idle', battleId: null, candidateTrackIds: [] });
  await expect(Promise.race([event, new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))])).resolves.toBe('timeout');
  repository.failQueueAppend = false;
});
