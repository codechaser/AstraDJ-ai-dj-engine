import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as createClient } from 'socket.io-client';
import { attachLoungeGateway } from '../src/socket/loungeGateway.js';
import { createQueueService } from '../src/services/queueService.js';

const secret = 'test-secret-astradj-only-32-characters';
const uidHost = '507f1f77bcf86cd799439011';
const uidListener = '507f1f77bcf86cd799439012';
const uidListener2 = '507f1f77bcf86cd799439013';
const uidListener3 = '507f1f77bcf86cd799439014';
const users = new Map([
  [uidHost, { _id: uidHost, displayName: 'Host', role: 'Host' }],
  [uidListener, { _id: uidListener, displayName: 'Listener', role: 'Listener' }],
  [uidListener2, { _id: uidListener2, displayName: 'Guest Two', role: 'Listener' }],
  [uidListener3, { _id: uidListener3, displayName: 'Guest Three', role: 'Listener' }],
]);
const trackData = new Map([
  ['t_2001', { trackId: 't_2001', title: 'Night Drive', artist: 'Nova Circuit', durationSeconds: 220 }],
  ['t_2002', { trackId: 't_2002', title: 'Neon Tide', artist: 'Nova Circuit', durationSeconds: 210 }],
  ['t_2003', { trackId: 't_2003', title: 'Afterglow', artist: 'Mira Vale', durationSeconds: 205 }],
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
    async findLoungeByInvite(code) { return [...lounges.values()].find((lounge) => lounge.inviteCode === code.toUpperCase()) ?? null; },
    async findLoungeById(id) { return lounges.get(id) ?? null; },
    async joinLounge(lounge, userId) {
      if (lounge.participantIds.includes(userId)) return lounge;
      if (lounge.participantIds.length >= lounge.settings.maxParticipants) return null;
      lounge.participantIds.push(userId);
      return lounge;
    },
    async listQueueEvents(loungeId) { return events.filter((event) => event.loungeId === loungeId).sort((a, b) => a.seq - b.seq); },
    async appendQueueEvents(batch) { events.push(...structuredClone(batch)); },
    async getTrack(trackId) { return trackData.get(trackId) ?? null; },
    async getUser(id) { return users.get(String(id)) ?? null; },
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
let sockets;

beforeEach(async () => {
  repository = makeRepository();
  queueService = createQueueService(repository, { voteFlushMs: 30_000 });
  server = createServer();
  ioServer = new Server(server, { transports: ['websocket'] });
  attachLoungeGateway(ioServer, { repository, queueService, secret });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  sockets = [];
});
afterEach(async () => {
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
