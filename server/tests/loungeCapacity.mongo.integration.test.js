import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
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
} catch { /* Optional test database is absent. */ }
const liveTest = safeMongoTarget ? test : test.skip;
const workerPath = fileURLToPath(new URL('./loungeGatewayWorker.js', import.meta.url));
const jwtSecret = crypto.randomBytes(32).toString('hex');
const participantLeaseTtlMs = 5_000;

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
      TEST_PARTICIPANT_LEASE_TTL_MS: String(participantLeaseTtlMs),
      AI_DJ_OUTRO_WINDOW_SECONDS: '12',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Gateway process did not become ready: ${output.replaceAll(mongoUri, '[isolated test URI]')}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes('READY')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null) reject(new Error(`Gateway process exited before readiness (${code}): ${output.replaceAll(mongoUri, '[isolated test URI]')}`));
    });
  });
  return { child, port, ready };
}

async function stopGatewayProcess(worker, signal = 'SIGTERM') {
  if (!worker || worker.child.exitCode !== null) return;
  const child = worker.child;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill(signal);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function makeToken(userId) {
  return jwt.sign({}, jwtSecret, {
    subject: String(userId), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 300, algorithm: 'HS256',
  });
}

function connectUser(port, userId) {
  return createClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'], reconnection: false, timeout: 5000, auth: { token: makeToken(userId) },
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

async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createObservedParticipantLeaseCoordinator(createCoordinator, observedKey) {
  const coordinator = createCoordinator();
  const waiters = [];
  return {
    waitForNextRun() {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for participant lease operation')), 5000);
        waiters.push(() => { clearTimeout(timeout); resolve(); });
      });
    },
    run(key, operation) {
      if (key === observedKey) waiters.shift()?.();
      return coordinator.run(key, operation);
    },
  };
}

liveTest('Mongo-backed admission enforces distinct active-user capacity across independent gateway processes', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'capacity');
  const clients = [];
  let connected = false;
  let processA;
  let processB;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ DJLounge }, { User }, { Track }] = await Promise.all([
      import('../src/models/DJLounge.js'), import('../src/models/User.js'), import('../src/models/Track.js'),
    ]);
    const ids = Object.fromEntries(['host', 'listenerA', 'listenerB', 'crashHost', 'crashListener', 'afterCrash'].map((name) => [name, new mongoose.Types.ObjectId()]));
    await User.create(Object.entries(ids).map(([name, _id]) => ({
      _id, email: `${name}-${String(_id)}@example.invalid`, displayName: name, passwordHash: 'test-only-hash',
      role: name.toLowerCase().includes('host') ? 'Host' : 'Listener',
    })));
    await Track.create({ trackId: 't_capacity_fixture', title: 'Capacity Fixture', artist: 'Test', durationSeconds: 120, acoustic: null, timeline: [] });
    const makeLounge = (loungeId, inviteCode, hostUserId) => ({
      loungeId, inviteCode, hostUserId, vibeProfile: 'Capacity integration fixture', queue: ['t_capacity_fixture'],
      currentTrackId: 't_capacity_fixture', status: 'scheduled', participantIds: [hostUserId],
      settings: { maxParticipants: 2, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });
    await DJLounge.create([
      makeLounge('lg_capacity0001', 'SP-CAPA', ids.host),
      makeLounge('lg_capacity0002', 'SP-CAPB', ids.crashHost),
      makeLounge('lg_capacity0003', 'SP-CAPC', ids.host),
    ]);

    [processA, processB] = await Promise.all([reservePort(), reservePort()]).then(([portA, portB]) => [startGatewayProcess(portA, uri), startGatewayProcess(portB, uri)]);
    await Promise.all([processA.ready, processB.ready]);

    const hostSocket = connectUser(processA.port, ids.host); clients.push(hostSocket); await waitForConnect(hostSocket);
    const hostJoined = await command(hostSocket, 'lounge.join', { inviteCode: 'SP-CAPA' });
    expect(hostJoined.ok).toBe(true);
    let lounge = await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean();
    expect(lounge.status).toBe('live');
    expect(lounge.startedAt).toBeInstanceOf(Date);

    const listenerSockets = [connectUser(processA.port, ids.listenerA), connectUser(processB.port, ids.listenerB)];
    clients.push(...listenerSockets);
    await Promise.all(listenerSockets.map(waitForConnect));
    const raceResults = await Promise.all(listenerSockets.map((socket) => command(socket, 'lounge.join', { inviteCode: 'SP-CAPA' })));
    expect(raceResults.filter((result) => result.ok)).toHaveLength(1);
    expect(raceResults.filter((result) => !result.ok).map((result) => result.error.code)).toEqual(['LOUNGE_FULL']);
    lounge = await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean();
    const activeUserIds = new Set(lounge.activeParticipantLeases.filter((lease) => lease.expiresAt > new Date()).map((lease) => String(lease.userId)));
    expect(activeUserIds.size).toBe(2);
    expect(lounge.participantIds).toHaveLength(2);
    const admittedIndex = raceResults.findIndex((result) => result.ok);
    const admittedUser = admittedIndex === 0 ? ids.listenerA : ids.listenerB;
    const rejectedIndex = 1 - admittedIndex;
    const rejectedUser = rejectedIndex === 0 ? ids.listenerA : ids.listenerB;
    const admittedSocket = listenerSockets[admittedIndex];
    const rejectedSocket = listenerSockets[rejectedIndex];

    expect((await command(admittedSocket, 'lounge.join', { inviteCode: 'SP-CAPA' })).ok).toBe(true);
    let leases = (await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean()).activeParticipantLeases;
    expect(leases.filter((lease) => String(lease.userId) === String(admittedUser))).toHaveLength(1);

    const secondAdmittedSocket = connectUser(rejectedIndex === 0 ? processA.port : processB.port, admittedUser); clients.push(secondAdmittedSocket); await waitForConnect(secondAdmittedSocket);
    expect((await command(secondAdmittedSocket, 'lounge.join', { inviteCode: 'SP-CAPA' })).ok).toBe(true);
    leases = (await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean()).activeParticipantLeases;
    expect(leases.filter((lease) => String(lease.userId) === String(admittedUser))).toHaveLength(2);
    expect(new Set(leases.filter((lease) => lease.expiresAt > new Date()).map((lease) => String(lease.userId))).size).toBe(2);

    admittedSocket.disconnect();
    await waitUntil(async () => (await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean()).activeParticipantLeases.filter((lease) => String(lease.userId) === String(admittedUser)).length === 1, 'Disconnecting one of two sockets released the active user seat');
    expect((await command(rejectedSocket, 'lounge.join', { inviteCode: 'SP-CAPA' })).error.code).toBe('LOUNGE_FULL');
    secondAdmittedSocket.disconnect();
    await waitUntil(async () => !(await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean()).activeParticipantLeases.some((lease) => String(lease.userId) === String(admittedUser)), 'Final socket disconnect did not release its process lease');
    const simultaneousRetrySocket = connectUser(rejectedIndex === 0 ? processB.port : processA.port, rejectedUser);
    clients.push(simultaneousRetrySocket); await waitForConnect(simultaneousRetrySocket);
    const simultaneousRetries = await Promise.all([
      command(rejectedSocket, 'lounge.join', { inviteCode: 'SP-CAPA' }),
      command(simultaneousRetrySocket, 'lounge.join', { inviteCode: 'SP-CAPA' }),
    ]);
    expect(simultaneousRetries.every((result) => result.ok)).toBe(true);
    lounge = await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean();
    expect(new Set(lounge.activeParticipantLeases.filter((lease) => lease.expiresAt > new Date()).map((lease) => String(lease.userId))).size).toBe(2);
    expect(lounge.activeParticipantLeases.filter((lease) => String(lease.userId) === String(rejectedUser))).toHaveLength(2);
    expect(lounge.participantIds.map(String)).toEqual(expect.arrayContaining([String(admittedUser), String(rejectedUser)]));
    rejectedSocket.disconnect(); simultaneousRetrySocket.disconnect();
    await waitUntil(async () => !(await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean()).activeParticipantLeases.some((lease) => String(lease.userId) === String(rejectedUser)), 'Final duplicate-retry disconnect did not release the user leases');

    const crashHostSocket = connectUser(processA.port, ids.crashHost); clients.push(crashHostSocket); await waitForConnect(crashHostSocket);
    expect((await command(crashHostSocket, 'lounge.join', { inviteCode: 'SP-CAPB' })).ok).toBe(true);
    const crashListenerSocket = connectUser(processA.port, ids.crashListener); clients.push(crashListenerSocket); await waitForConnect(crashListenerSocket);
    expect((await command(crashListenerSocket, 'lounge.join', { inviteCode: 'SP-CAPB' })).ok).toBe(true);
    expect(new Set((await DJLounge.findOne({ loungeId: 'lg_capacity0002' }).lean()).activeParticipantLeases.map((lease) => String(lease.userId))).size).toBe(2);
    await stopGatewayProcess(processA, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, participantLeaseTtlMs + 250));
    const afterCrashSocket = connectUser(processB.port, ids.afterCrash); clients.push(afterCrashSocket); await waitForConnect(afterCrashSocket);
    expect((await command(afterCrashSocket, 'lounge.join', { inviteCode: 'SP-CAPB' })).ok).toBe(true);
    const afterCrash = await DJLounge.findOne({ loungeId: 'lg_capacity0002' }).lean();
    expect(afterCrash.activeParticipantLeases.map((lease) => String(lease.userId))).toEqual([String(ids.afterCrash)]);

    const isolatedSocket = connectUser(processB.port, ids.afterCrash); clients.push(isolatedSocket); await waitForConnect(isolatedSocket);
    expect((await command(isolatedSocket, 'lounge.join', { inviteCode: 'SP-CAPC' })).ok).toBe(true);
    const isolatedLounge = await DJLounge.findOne({ loungeId: 'lg_capacity0003' }).lean();
    expect(isolatedLounge.activeParticipantLeases.map((lease) => String(lease.userId))).toEqual([String(ids.afterCrash)]);
    expect((await DJLounge.findOne({ loungeId: 'lg_capacity0001' }).lean()).activeParticipantLeases.some((lease) => String(lease.userId) === String(ids.afterCrash))).toBe(false);
    await DJLounge.updateOne({ loungeId: 'lg_capacity0003' }, { $set: { status: 'ended', endedAt: new Date() } });
    const endedSocket = connectUser(processB.port, ids.afterCrash); clients.push(endedSocket); await waitForConnect(endedSocket);
    expect((await command(endedSocket, 'lounge.join', { inviteCode: 'SP-CAPC' })).error.code).toBe('LOUNGE_NOT_FOUND');
  } finally {
    for (const client of clients) client.disconnect();
    await Promise.all([stopGatewayProcess(processA), stopGatewayProcess(processB)]);
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 90_000);

liveTest('Mongo-backed final disconnect is serialized with a pending lease renewal and leaves the seat available', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'leaserace');
  const clients = [];
  let connected = false;
  let server;
  let io;
  let gateway;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ DJLounge }, { User }, { Track }, { queueRepository }, { createQueueService }, { attachLoungeGateway }, { createLoungeCommandCoordinator }] = await Promise.all([
      import('../src/models/DJLounge.js'), import('../src/models/User.js'), import('../src/models/Track.js'),
      import('../src/services/queueRepository.js'), import('../src/services/queueService.js'),
      import('../src/socket/loungeGateway.js'), import('../src/services/loungeCommandCoordinator.js'),
    ]);
    const ids = Object.fromEntries(['host', 'leavingListener', 'nextListener'].map((name) => [name, new mongoose.Types.ObjectId()]));
    await User.create(Object.entries(ids).map(([name, _id]) => ({
      _id, email: `${name}-${String(_id)}@example.invalid`, displayName: name, passwordHash: 'test-only-hash',
      role: name === 'host' ? 'Host' : 'Listener',
    })));
    await Track.create({ trackId: 't_capacity_race', title: 'Lease Race Fixture', artist: 'Test', durationSeconds: 120, acoustic: null, timeline: [] });
    const loungeId = 'lg_leaserace0001';
    const inviteCode = 'SP-RACE';
    await DJLounge.create({
      loungeId, inviteCode, hostUserId: ids.host, vibeProfile: 'Lease race integration fixture', queue: ['t_capacity_race'],
      currentTrackId: 't_capacity_race', status: 'scheduled', participantIds: [ids.host],
      settings: { maxParticipants: 2, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });

    let targetLeaseId;
    const renewalStarted = deferred();
    const resumeRenewal = deferred();
    const releaseCompleted = deferred();
    const targetKey = `${loungeId}\0${String(ids.leavingListener)}`;
    const participantLeaseCoordinator = createObservedParticipantLeaseCoordinator(createLoungeCommandCoordinator, targetKey);
    let pausedTargetRenewal = false;
    const repository = new Proxy(queueRepository, {
      get(target, property) {
        if (property === 'renewAdmissionLeases') return async (requestedLoungeId, leaseIds, now, expiresAt) => {
          if (!pausedTargetRenewal && requestedLoungeId === loungeId && targetLeaseId && leaseIds.includes(targetLeaseId)) {
            pausedTargetRenewal = true;
            renewalStarted.resolve();
            await resumeRenewal.promise;
          }
          return target.renewAdmissionLeases(requestedLoungeId, leaseIds, now, expiresAt);
        };
        if (property === 'releaseAdmissionLease') return async (requestedLoungeId, leaseId) => {
          await target.releaseAdmissionLease(requestedLoungeId, leaseId);
          if (requestedLoungeId === loungeId && leaseId === targetLeaseId) releaseCompleted.resolve();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const jwtSecret = crypto.randomBytes(32).toString('hex');
    const queueService = createQueueService(repository);
    server = createServer();
    io = new SocketServer(server, { cors: { origin: false }, transports: ['websocket'] });
    gateway = attachLoungeGateway(io, {
      repository, queueService, secret: jwtSecret, participantLeaseCoordinator, participantLeaseRenewalIntervalMs: 60_000,
    });
    const port = await reservePort();
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    const connect = (userId) => {
      const socket = createClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'], reconnection: false, timeout: 5000, auth: { token: jwt.sign({}, jwtSecret, { subject: String(userId), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 300, algorithm: 'HS256' }) },
      });
      clients.push(socket);
      return socket;
    };
    const hostSocket = connect(ids.host);
    const leavingSocket = connect(ids.leavingListener);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(leavingSocket)]);
    expect((await command(hostSocket, 'lounge.join', { inviteCode })).ok).toBe(true);
    expect((await command(leavingSocket, 'lounge.join', { inviteCode })).ok).toBe(true);
    let lounge = await DJLounge.findOne({ loungeId }).lean();
    targetLeaseId = lounge.activeParticipantLeases.find((lease) => String(lease.userId) === String(ids.leavingListener)).leaseId;

    const renewal = gateway.renewParticipantLeases();
    await renewalStarted.promise;
    const disconnectQueued = participantLeaseCoordinator.waitForNextRun();
    leavingSocket.disconnect();
    try {
      await disconnectQueued;
      lounge = await DJLounge.findOne({ loungeId }).lean();
      expect(lounge.activeParticipantLeases.some((lease) => lease.leaseId === targetLeaseId && lease.expiresAt > new Date())).toBe(true);
    } finally {
      resumeRenewal.resolve();
    }
    await renewal;
    await releaseCompleted.promise;
    lounge = await DJLounge.findOne({ loungeId }).lean();
    expect(lounge.activeParticipantLeases.some((lease) => lease.leaseId === targetLeaseId)).toBe(false);

    const nextSocket = connect(ids.nextListener);
    await waitForConnect(nextSocket);
    expect((await command(nextSocket, 'lounge.join', { inviteCode })).ok).toBe(true);
    lounge = await DJLounge.findOne({ loungeId }).lean();
    expect(new Set(lounge.activeParticipantLeases.filter((lease) => lease.expiresAt > new Date()).map((lease) => String(lease.userId))).size).toBe(2);
    expect(lounge.activeParticipantLeases.some((lease) => String(lease.userId) === String(ids.leavingListener))).toBe(false);
  } finally {
    for (const client of clients) client.disconnect();
    if (gateway) await gateway.close();
    if (io) await new Promise((resolve) => io.close(resolve));
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 45_000);
