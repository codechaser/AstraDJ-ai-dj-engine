import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { io as createClient } from 'socket.io-client';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
let safeMongoTarget = false;
try {
  const url = new URL(configuredMongoUri);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('?')[0]);
  safeMongoTarget = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && database.startsWith('astradj_test_');
} catch { /* The genuine multi-process test is skipped without a safe local test URI. */ }
const liveTest = safeMongoTarget ? test : test.skip;
const workerPath = fileURLToPath(new URL('./loungeGatewayWorker.js', import.meta.url));
const jwtSecret = crypto.randomBytes(32).toString('hex');
const presenceTtlMs = 3_000;

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

function startGatewayProcess(port, mongoUri) {
  const child = spawn(process.execPath, [workerPath], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_ENV: 'test',
      PORT: String(port),
      MONGODB_URI: mongoUri,
      JWT_ACCESS_SECRET: jwtSecret,
      JWT_ACCESS_TTL_SECONDS: '900',
      JWT_REFRESH_TTL_DAYS: '7',
      TEST_PARTICIPANT_LEASE_TTL_MS: String(presenceTtlMs),
      TEST_GATEWAY_PRESENCE_TTL_MS: String(presenceTtlMs),
      TEST_GATEWAY_PRESENCE_POLL_MS: '100',
      AI_DJ_OUTRO_WINDOW_SECONDS: '12',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-3000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-3000); });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Gateway worker readiness timed out: ${output.replaceAll(mongoUri, '[isolated test URI]')}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes('READY')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null) reject(new Error(`Gateway worker exited before readiness (${code}): ${output.replaceAll(mongoUri, '[isolated test URI]')}`));
    });
  });
  return { child, port, ready };
}

async function stopGatewayProcess(worker, signal = 'SIGTERM') {
  if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = new Promise((resolve) => worker.child.once('exit', resolve));
  worker.child.kill(signal);
  let timeout;
  await Promise.race([exited, new Promise((resolve) => { timeout = setTimeout(resolve, 8_000); })]);
  clearTimeout(timeout);
  if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
}

function token(userId) {
  return jwt.sign({}, jwtSecret, { subject: String(userId), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 300, algorithm: 'HS256' });
}

function connectUser(port, userId) {
  return createClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'], reconnection: false, timeout: 5000, auth: { token: token(userId) },
  });
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 8000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timeout); reject(new Error(`Socket connection failed: ${error.message}`)); });
  });
}

function command(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 8000);
    socket.emit(event, payload, (result) => { clearTimeout(timeout); resolve(result); });
  });
}

function watchEvent(socket, event, predicate = () => true) {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`Timed out waiting for ${event}`));
  }, 8000);
  const handler = (payload) => {
    if (!predicate(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload);
  };
  socket.on(event, handler);
  return { promise, cancel() { clearTimeout(timer); socket.off(event, handler); } };
}

async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

liveTest('shared Host presence coordinates queue commands across independent gateways and expires safely after crashes', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'presence');
  const clients = [];
  let connected = false;
  let processA;
  let processB;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ DJLounge }, { User }, { Track }, { QueueEvent }, { queueRepository }] = await Promise.all([
      import('../src/models/DJLounge.js'), import('../src/models/User.js'), import('../src/models/Track.js'),
      import('../src/models/QueueEvent.js'), import('../src/services/queueRepository.js'),
    ]);
    const ids = Object.fromEntries(['owner', 'coDj', 'listener', 'otherHost', 'outsider', 'crashOwner', 'crashCoDj', 'offlineOwner', 'offlineCoDj', 'generationOwner'].map((name) => [name, new mongoose.Types.ObjectId()]));
    const roleFor = (name) => name === 'owner' || name === 'otherHost' || name === 'outsider' || name === 'crashOwner' || name === 'offlineOwner' || name === 'generationOwner' ? 'Host' : name.toLowerCase().includes('codj') ? 'Co-DJ' : 'Listener';
    await User.create(Object.entries(ids).map(([name, _id]) => ({
      _id, email: `${name}-${String(_id)}@example.invalid`, displayName: name, passwordHash: 'test-only-hash', role: roleFor(name),
    })));
    await Track.create(['t_presence_current', 't_presence_added', 't_presence_added2', 't_presence_race', 't_presence_rejected'].map((trackId) => ({
      trackId, title: trackId, artist: 'Presence Fixture', durationSeconds: 120, acoustic: null, timeline: [],
    })));
    const lounges = [
      { loungeId: 'lg_presence0001', inviteCode: 'SP-PRES', host: ids.owner, members: ['owner', 'coDj', 'listener', 'otherHost'], title: 'Main' },
      { loungeId: 'lg_presence0002', inviteCode: 'SP-CRS2', host: ids.crashOwner, members: ['crashOwner', 'crashCoDj'], title: 'Crash reconnect' },
      { loungeId: 'lg_presence0003', inviteCode: 'SP-CRS3', host: ids.offlineOwner, members: ['offlineOwner', 'offlineCoDj'], title: 'Crash expiry' },
      { loungeId: 'lg_presence0004', inviteCode: 'SP-GENR', host: ids.generationOwner, members: ['generationOwner'], title: 'Generation fence' },
    ];
    await DJLounge.create(lounges.map(({ loungeId, inviteCode, host, members, title }) => ({
      loungeId, inviteCode, hostUserId: host, vibeProfile: `${title} integration fixture`, queue: ['t_presence_current'], currentTrackId: 't_presence_current',
      status: 'scheduled', participantIds: members.map((name) => ids[name]),
      settings: { maxParticipants: 8, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    })));

    const [portA, portB] = await Promise.all([reservePort(), reservePort()]);
    processA = startGatewayProcess(portA, uri);
    processB = startGatewayProcess(portB, uri);
    await Promise.all([processA.ready, processB.ready]);

    const hostA = connectUser(portA, ids.owner); clients.push(hostA); await waitForConnect(hostA);
    const hostJoined = await command(hostA, 'lounge.join', { inviteCode: 'SP-PRES' });
    expect(hostJoined.ok).toBe(true);
    const coDjB = connectUser(portB, ids.coDj); clients.push(coDjB); await waitForConnect(coDjB);
    const coDjJoined = await command(coDjB, 'lounge.join', { inviteCode: 'SP-PRES' });
    expect(coDjJoined).toMatchObject({ ok: true, state: { hostDisconnected: false } });
    expect((await command(hostA, 'lounge.join', { inviteCode: 'SP-PRES' })).ok).toBe(true);
    let hostPresenceRows = (await DJLounge.findOne({ loungeId: 'lg_presence0001' }).select('gatewayPresences').lean()).gatewayPresences.filter((row) => String(row.userId) === String(ids.owner));
    expect(hostPresenceRows).toHaveLength(1);
    expect(hostPresenceRows[0].socketCount).toBe(1);

    const hostQueueUpdate = watchEvent(hostA, 'lounge.queue.update', (message) => message.payload?.queue?.some(({ trackId }) => trackId === 't_presence_added'));
    const coDjQueueUpdate = watchEvent(coDjB, 'lounge.queue.update', (message) => message.payload?.queue?.some(({ trackId }) => trackId === 't_presence_added'));
    hostQueueUpdate.promise.catch(() => {});
    coDjQueueUpdate.promise.catch(() => {});
    const added = await command(coDjB, 'lounge.queue.add', { trackId: 't_presence_added' });
    if (!added.ok) throw new Error(`Cross-instance queue add failed: ${JSON.stringify(added.error)}`);
    await expect(hostQueueUpdate.promise).resolves.toMatchObject({ loungeId: 'lg_presence0001', payload: { reason: 'add' } });
    await expect(coDjQueueUpdate.promise).resolves.toMatchObject({ loungeId: 'lg_presence0001', payload: { reason: 'add' } });
    let lounge = await DJLounge.findOne({ loungeId: 'lg_presence0001' }).lean();
    expect(lounge.coordination.revision).toBe(1);
    expect(lounge.coordination.outbox).toHaveLength(0);
    expect((await QueueEvent.find({ loungeId: lounge.loungeId, type: 'track.added' }).lean()).map((event) => event.payload.trackId)).toEqual(['t_presence_added']);

    const listener = connectUser(portB, ids.listener); clients.push(listener); await waitForConnect(listener);
    expect((await command(listener, 'lounge.join', { inviteCode: 'SP-PRES' })).ok).toBe(true);
    expect((await command(listener, 'lounge.queue.add', { trackId: 't_presence_rejected' })).error.code).toBe('FORBIDDEN');
    const otherHost = connectUser(portB, ids.otherHost); clients.push(otherHost); await waitForConnect(otherHost);
    expect((await command(otherHost, 'lounge.join', { inviteCode: 'SP-PRES' })).ok).toBe(true);
    expect((await command(otherHost, 'lounge.soundclash.open', {})).error.code).toBe('LOUNGE_HOST_REQUIRED');
    expect((await command(otherHost, 'lounge.soundclash.resolve', { battleId: 'not-a-battle', winningTrackId: 't_presence_added' })).error.code).toBe('LOUNGE_HOST_REQUIRED');
    const outsider = connectUser(portB, ids.outsider); clients.push(outsider); await waitForConnect(outsider);
    expect((await command(outsider, 'lounge.queue.add', { trackId: 't_presence_rejected' })).error.code).toBe('LOUNGE_MEMBERSHIP_REQUIRED');

    const secondHostSocket = connectUser(portA, ids.owner); clients.push(secondHostSocket); await waitForConnect(secondHostSocket);
    expect((await command(secondHostSocket, 'lounge.join', { inviteCode: 'SP-PRES' })).ok).toBe(true);
    let presenceRows = (await DJLounge.findOne({ loungeId: 'lg_presence0001' }).select('gatewayPresences').lean()).gatewayPresences.filter((row) => String(row.userId) === String(ids.owner));
    expect(presenceRows).toHaveLength(1);
    expect(presenceRows[0].socketCount).toBe(2);
    hostA.disconnect();
    await waitUntil(async () => {
      const doc = await DJLounge.findOne({ loungeId: 'lg_presence0001' }).select('gatewayPresences').lean();
      const row = doc.gatewayPresences.find((entry) => String(entry.userId) === String(ids.owner));
      return row?.socketCount === 1;
    }, 'Disconnecting one Host socket incorrectly removed shared Host presence');
    expect((await command(coDjB, 'lounge.queue.add', { trackId: 't_presence_added2' })).ok).toBe(true);

    const raceBefore = await DJLounge.findOne({ loungeId: 'lg_presence0001' }).lean();
    const raceEventCount = await QueueEvent.countDocuments({ loungeId: 'lg_presence0001', type: 'track.added' });
    const raceUpdate = watchEvent(coDjB, 'lounge.queue.update', (message) => message.payload?.queue?.some(({ trackId }) => trackId === 't_presence_race'));
    raceUpdate.promise.catch(() => {});
    const ownerOfflineUpdate = watchEvent(coDjB, 'lounge.presence.update', (message) => message.payload?.hostDisconnected === true);
    ownerOfflineUpdate.promise.catch(() => {});
    const raceCommand = command(coDjB, 'lounge.queue.add', { trackId: 't_presence_race' });
    secondHostSocket.disconnect();
    const raceResult = await raceCommand;
    if (raceResult.ok) {
      await raceUpdate.promise;
      lounge = await DJLounge.findOne({ loungeId: 'lg_presence0001' }).lean();
      expect(lounge.coordination.revision).toBe(raceBefore.coordination.revision + 1);
      expect(await QueueEvent.countDocuments({ loungeId: 'lg_presence0001', type: 'track.added' })).toBe(raceEventCount + 1);
    } else {
      raceUpdate.cancel();
      expect(raceResult.error.code).toBe('HOST_DISCONNECTED');
      lounge = await DJLounge.findOne({ loungeId: 'lg_presence0001' }).lean();
      expect(lounge.coordination.revision).toBe(raceBefore.coordination.revision);
      expect(await QueueEvent.countDocuments({ loungeId: 'lg_presence0001', type: 'track.added' })).toBe(raceEventCount);
    }
    await waitUntil(() => queueRepository.hasActiveGatewayPresence('lg_presence0001', ids.owner).then((present) => !present), 'The Host remained present after its final local socket disconnected');
    await expect(ownerOfflineUpdate.promise).resolves.toMatchObject({ loungeId: 'lg_presence0001', payload: { action: 'sync', hostDisconnected: true } });
    expect((await command(coDjB, 'lounge.sync.request')).state.hostDisconnected).toBe(true);
    const beforeRejected = await DJLounge.findOne({ loungeId: 'lg_presence0001' }).lean();
    const beforeRejectedEvents = await QueueEvent.countDocuments({ loungeId: 'lg_presence0001', type: 'track.added' });
    expect((await command(coDjB, 'lounge.queue.add', { trackId: 't_presence_rejected' })).error.code).toBe('HOST_DISCONNECTED');
    lounge = await DJLounge.findOne({ loungeId: 'lg_presence0001' }).lean();
    expect(lounge.coordination.revision).toBe(beforeRejected.coordination.revision);
    expect(await QueueEvent.countDocuments({ loungeId: 'lg_presence0001', type: 'track.added' })).toBe(beforeRejectedEvents);

    const generationGatewayId = 'generation-fence-test-gateway';
    await DJLounge.updateOne({ loungeId: 'lg_presence0004' }, { $set: { status: 'live' } });
    await queueRepository.upsertGatewayPresence('lg_presence0004', { gatewayId: generationGatewayId, userId: ids.generationOwner, generation: 'old-generation', socketCount: 1 }, presenceTtlMs);
    await queueRepository.upsertGatewayPresence('lg_presence0004', { gatewayId: generationGatewayId, userId: ids.generationOwner, generation: 'new-generation', socketCount: 1 }, presenceTtlMs);
    expect(await queueRepository.removeGatewayPresence('lg_presence0004', { gatewayId: generationGatewayId, userId: ids.generationOwner, generation: 'old-generation' })).toBe(false);
    expect(await queueRepository.hasActiveGatewayPresence('lg_presence0004', ids.generationOwner)).toBe(true);
    await queueRepository.removeGatewayPresence('lg_presence0004', { gatewayId: generationGatewayId, userId: ids.generationOwner, generation: 'new-generation' });

    const crashOwnerA = connectUser(portA, ids.crashOwner); clients.push(crashOwnerA); await waitForConnect(crashOwnerA);
    const crashOwnerAJoin = await command(crashOwnerA, 'lounge.join', { inviteCode: 'SP-CRS2' });
    expect(crashOwnerAJoin.ok).toBe(true);
    const crashCoDjB = connectUser(portB, ids.crashCoDj); clients.push(crashCoDjB); await waitForConnect(crashCoDjB);
    expect((await command(crashCoDjB, 'lounge.join', { inviteCode: 'SP-CRS2' })).ok).toBe(true);
    const offlineOwnerA = connectUser(portA, ids.offlineOwner); clients.push(offlineOwnerA); await waitForConnect(offlineOwnerA);
    expect((await command(offlineOwnerA, 'lounge.join', { inviteCode: 'SP-CRS3' })).ok).toBe(true);
    const offlineCoDjB = connectUser(portB, ids.offlineCoDj); clients.push(offlineCoDjB); await waitForConnect(offlineCoDjB);
    expect((await command(offlineCoDjB, 'lounge.join', { inviteCode: 'SP-CRS3' })).ok).toBe(true);
    const crashOfflineUpdate = watchEvent(offlineCoDjB, 'lounge.presence.update', (message) => message.payload?.hostDisconnected === true);
    crashOfflineUpdate.promise.catch(() => {});
    const oldCrashPresence = (await DJLounge.findOne({ loungeId: 'lg_presence0002' }).select('gatewayPresences').lean()).gatewayPresences.find((row) => String(row.userId) === String(ids.crashOwner));
    const crashStartedAt = Date.now();
    const processAExited = new Promise((resolve) => processA.child.once('exit', resolve));
    processA.child.kill('SIGKILL');
    await processAExited;

    const reconnectBeforeExpiry = connectUser(portB, ids.crashOwner); clients.push(reconnectBeforeExpiry); await waitForConnect(reconnectBeforeExpiry);
    expect((await command(reconnectBeforeExpiry, 'lounge.join', { inviteCode: 'SP-CRS2' })).ok).toBe(true);
    expect(await queueRepository.hasActiveGatewayPresence('lg_presence0002', ids.crashOwner)).toBe(true);
    await queueRepository.removeGatewayPresence('lg_presence0002', {
      gatewayId: oldCrashPresence.gatewayId, userId: ids.crashOwner, generation: oldCrashPresence.generation,
    });
    expect(await queueRepository.hasActiveGatewayPresence('lg_presence0002', ids.crashOwner)).toBe(true);

    await waitUntil(() => queueRepository.hasActiveGatewayPresence('lg_presence0003', ids.offlineOwner).then((present) => !present), 'Crashed gateway Host presence did not expire', presenceTtlMs + 2_500);
    expect(Date.now() - crashStartedAt).toBeLessThan(presenceTtlMs + 2_500);
    await expect(crashOfflineUpdate.promise).resolves.toMatchObject({ loungeId: 'lg_presence0003', payload: { action: 'sync', hostDisconnected: true } });
    expect((await command(offlineCoDjB, 'lounge.sync.request')).state.hostDisconnected).toBe(true);
    const offlineBefore = await DJLounge.findOne({ loungeId: 'lg_presence0003' }).lean();
    const offlineEventCount = await QueueEvent.countDocuments({ loungeId: 'lg_presence0003' });
    expect((await command(offlineCoDjB, 'lounge.queue.add', { trackId: 't_presence_rejected' })).error.code).toBe('HOST_DISCONNECTED');
    const offlineAfter = await DJLounge.findOne({ loungeId: 'lg_presence0003' }).lean();
    expect(offlineAfter.coordination.revision).toBe(offlineBefore.coordination.revision);
    expect(await QueueEvent.countDocuments({ loungeId: 'lg_presence0003' })).toBe(offlineEventCount);
  } finally {
    for (const client of clients) client.disconnect();
    await Promise.all([stopGatewayProcess(processA), stopGatewayProcess(processB)]);
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 60_000);
