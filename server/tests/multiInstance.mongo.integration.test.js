import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';
import jwt from 'jsonwebtoken';
import { io as createClient } from 'socket.io-client';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;
const socketCommand = (socket, event, payload = {}) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} acknowledgement`)), 3000);
  socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); });
});
const workerPath = fileURLToPath(new URL('./multiInstanceQueueWorker.js', import.meta.url));
function runQueueWorker(uri, loungeId, trackId, actorId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, loungeId, trackId, String(actorId)], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, MONGODB_TEST_URI: uri },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Coordination worker timed out: ${output.replaceAll(uri, '[test database URI redacted]')}`));
    }, 20_000);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Coordination worker exited ${code}: ${output.replaceAll(uri, '[test database URI redacted]')}`));
    });
  });
}

liveTest('two independent queue and Soundclash instances coordinate through Mongo CAS and durable outbox', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'multinode');
  let connected = false;
  let battleA;
  let battleB;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ DJLounge }, { Track }, { queueRepository }, { createQueueService }, { createSoundclashService }, { QueueEvent }, { User }] = await Promise.all([
      import('../src/models/DJLounge.js'), import('../src/models/Track.js'), import('../src/services/queueRepository.js'),
      import('../src/services/queueService.js'), import('../src/services/soundclashService.js'), import('../src/models/QueueEvent.js'), import('../src/models/User.js'),
    ]);
    const host = new mongoose.Types.ObjectId();
    const listeners = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const loungeId = 'lg_940000000001';
    const battleLoungeId = 'lg_940000000002';
    const makeLounge = (id, inviteCode, queue) => ({
      loungeId: id, inviteCode, hostUserId: host, vibeProfile: 'Multi-instance fixture',
      queue, currentTrackId: queue[0], status: 'live', participantIds: [host, ...listeners],
      settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });
    await DJLounge.create([makeLounge(loungeId, 'SP-9X2L', ['t_9401', 't_9402']), makeLounge(battleLoungeId, 'SP-9X2M', ['t_9401', 't_9402'])]);
    await User.create([{ _id: host, email: `${host}@example.invalid`, displayName: 'Test Host', passwordHash: 'test-only-hash', role: 'Host' }, ...listeners.map((id, index) => ({ _id: id, email: `${id}@example.invalid`, displayName: `Listener ${index}`, passwordHash: 'test-only-hash', role: 'Listener' }))]);
    await Track.create([
      { trackId: 't_9401', title: 'Current', artist: 'Fixture', durationSeconds: 180, acoustic: { bpm: 120, camelotKey: '8A', energy: 0.5, valence: 0.5 }, timeline: [] },
      { trackId: 't_9402', title: 'Next', artist: 'Fixture', durationSeconds: 180, acoustic: { bpm: 120, camelotKey: '8A', energy: 0.5, valence: 0.5 }, timeline: [] },
      ...['t_9403', 't_9404', 't_9405', 't_9406', 't_9407', 't_9408', 't_9409', 't_9410'].map((trackId) => ({ trackId, title: trackId, artist: 'Fixture', durationSeconds: 180, acoustic: null, timeline: [] })),
    ]);

    const queueA = createQueueService(queueRepository);
    const queueB = createQueueService(queueRepository);
    const lounge = await queueRepository.findLoungeById(loungeId);
    const additions = await Promise.all([
      queueA.addTrack({ lounge, actor: { id: host, role: 'Host' }, trackId: 't_9403' }),
      queueB.addTrack({ lounge, actor: { id: host, role: 'Host' }, trackId: 't_9404' }),
    ]);
    expect(additions).toHaveLength(2);
    const snapshotA = await queueA.snapshot(lounge);
    const snapshotB = await queueB.snapshot(lounge);
    expect(snapshotA.nextUp.map((track) => track.trackId).sort()).toEqual(['t_9402', 't_9403', 't_9404']);
    expect(snapshotA.nextUp.map((track) => track.trackId)).toEqual(snapshotB.nextUp.map((track) => track.trackId));
    const addedEvents = await QueueEvent.find({ loungeId, type: 'track.added' }).sort({ seq: 1 }).lean();
    expect(addedEvents.map((event) => event.payload.trackId).sort()).toEqual(['t_9403', 't_9404']);
    expect(new Set(addedEvents.map((event) => event.seq)).size).toBe(2);

    await Promise.all([
      queueA.vote({ lounge, actor: { id: listeners[0], role: 'Listener' }, trackId: 't_9402', value: 1 }),
      queueB.vote({ lounge, actor: { id: listeners[1], role: 'Listener' }, trackId: 't_9402', value: 1 }),
    ]);
    expect((await queueA.snapshot(lounge)).nextUp.find((track) => track.trackId === 't_9402').votes).toBe(2);

    const pendingSegue = { fromTrackId: 't_9401', trackId: 't_9402', createdAt: new Date() };
    const prepared = await Promise.all([
      queueRepository.setPendingSegue(loungeId, 't_9401', pendingSegue),
      queueRepository.setPendingSegue(loungeId, 't_9401', pendingSegue),
    ]);
    expect(prepared.every(Boolean)).toBe(true);
    expect(await QueueEvent.countDocuments({ loungeId, type: 'segue.prepared' })).toBe(1);
    await queueRepository.clearPendingSegue(loungeId, 't_9401');
    await expect(queueA.transitionTo({ lounge, actor: { id: host, role: 'Host' }, trackId: 't_9402' })).rejects.toMatchObject({ code: 'SEGUE_NOT_PENDING' });
    await queueRepository.setPendingSegue(loungeId, 't_9401', { ...pendingSegue, createdAt: new Date() });

    const transitions = await Promise.allSettled([
      queueA.transitionTo({ lounge, actor: { id: host, role: 'Host' }, trackId: 't_9402' }),
      queueB.transitionTo({ lounge, actor: { id: host, role: 'Host' }, trackId: 't_9402' }),
    ]);
    expect(transitions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await QueueEvent.countDocuments({ loungeId, type: 'track.transitioned' })).toBe(1);
    expect(await QueueEvent.countDocuments({ loungeId, type: 'segue.cancelled' })).toBe(1);
    expect((await queueB.snapshot(lounge)).nowPlaying.trackId).toBe('t_9402');
    expect((await DJLounge.findOne({ loungeId }).lean()).pendingSegue).toBeUndefined();

    const originalUpdateOne = QueueEvent.updateOne;
    QueueEvent.updateOne = async (...args) => { throw new Error('simulated process failure during outbox projection'); };
    try {
      await expect(queueA.addTrack({ lounge, actor: { id: host, role: 'Host' }, trackId: 't_9407' })).rejects.toThrow('simulated process failure');
    } finally { QueueEvent.updateOne = originalUpdateOne; }
    expect(await QueueEvent.countDocuments({ loungeId, type: 'track.added', 'payload.trackId': 't_9407' })).toBe(0);
    await runQueueWorker(uri, loungeId, '__drain__', host);
    expect(await QueueEvent.countDocuments({ loungeId, type: 'track.added', 'payload.trackId': 't_9407' })).toBe(1);
    expect((await DJLounge.findOne({ loungeId }).lean()).coordination.outbox).toHaveLength(0);

    const originalLoungeUpdateOne = DJLounge.updateOne;
    let failOutboxAcknowledgement = true;
    DJLounge.updateOne = async (filter, update, ...args) => {
      if (failOutboxAcknowledgement && update?.$pull?.['coordination.outbox']) {
        failOutboxAcknowledgement = false;
        throw new Error('simulated process failure after outbox projection before acknowledgement');
      }
      return originalLoungeUpdateOne.call(DJLounge, filter, update, ...args);
    };
    try {
      await expect(queueA.addTrack({ lounge, actor: { id: host, role: 'Host' }, trackId: 't_9410' })).rejects.toThrow('simulated process failure after outbox projection');
    } finally { DJLounge.updateOne = originalLoungeUpdateOne; }
    expect(await QueueEvent.countDocuments({ loungeId, type: 'track.added', 'payload.trackId': 't_9410' })).toBe(1);
    expect((await DJLounge.findOne({ loungeId }).lean()).coordination.outbox).toHaveLength(1);
    await runQueueWorker(uri, loungeId, '__drain__', host);
    expect(await QueueEvent.countDocuments({ loungeId, type: 'track.added', 'payload.trackId': 't_9410' })).toBe(1);
    expect((await DJLounge.findOne({ loungeId }).lean()).coordination.outbox).toHaveLength(0);

    await Promise.all([
      runQueueWorker(uri, loungeId, 't_9408', host),
      runQueueWorker(uri, loungeId, 't_9409', host),
    ]);
    const processEvents = await QueueEvent.find({ loungeId, type: 'track.added', 'payload.trackId': { $in: ['t_9408', 't_9409'] } }).lean();
    expect(processEvents).toHaveLength(2);
    expect(new Set(processEvents.map((event) => event.seq)).size).toBe(2);
    expect((await queueA.snapshot(lounge)).nextUp.map(({ trackId }) => trackId)).toEqual((await queueB.snapshot(lounge)).nextUp.map(({ trackId }) => trackId));

    const battleQueueA = createQueueService(queueRepository);
    const battleQueueB = createQueueService(queueRepository);
    battleA = createSoundclashService({ repository: queueRepository, queueService: battleQueueA, voteDurationMs: 120 });
    battleB = createSoundclashService({ repository: queueRepository, queueService: battleQueueB, voteDurationMs: 120 });
    const battleLounge = await queueRepository.findLoungeById(battleLoungeId);
    const submissions = await Promise.all([
      battleA.submit({ lounge: battleLounge, actor: { id: listeners[0], role: 'Listener' }, trackId: 't_9405' }),
      battleB.submit({ lounge: battleLounge, actor: { id: listeners[1], role: 'Listener' }, trackId: 't_9406' }),
    ]);
    expect(new Set(submissions.map(({ state }) => state.battleId)).size).toBe(1);
    const battleId = submissions[0].state.battleId;
    await Promise.all([
      battleA.vote({ lounge: battleLounge, actor: { id: listeners[0], role: 'Listener' }, battleId, trackId: 't_9405' }),
      battleB.vote({ lounge: battleLounge, actor: { id: listeners[2], role: 'Listener' }, battleId, trackId: 't_9406' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const resolutions = await Promise.all([
      battleA.forceResolve({ lounge: battleLounge, actor: { id: host, role: 'Host' }, battleId, winningTrackId: 't_9405' }),
      battleB.forceResolve({ lounge: battleLounge, actor: { id: host, role: 'Host' }, battleId, winningTrackId: 't_9405' }),
    ]);
    expect(resolutions.map(({ state }) => state.status)).toEqual(['resolved', 'resolved']);
    expect(await QueueEvent.countDocuments({ loungeId: battleLoungeId, type: 'soundclash.voted' })).toBe(2);
    expect(await QueueEvent.countDocuments({ loungeId: battleLoungeId, type: 'soundclash.resolved' })).toBe(1);
    expect((await battleQueueB.snapshot(battleLounge)).nextUp[0].trackId).toBe('t_9405');
  } finally {
    battleA?.close(); battleB?.close();
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 60000);

liveTest('two independent Socket.io gateways deliver a durable queue event to clients on both instances', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'gatewaycoord');
  let connected = false;
  const clients = [];
  const gateways = [];
  const servers = [];
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ DJLounge }, { Track }, { User }, { queueRepository }, { createQueueService }, { attachLoungeGateway }] = await Promise.all([
      import('../src/models/DJLounge.js'), import('../src/models/Track.js'), import('../src/models/User.js'),
      import('../src/services/queueRepository.js'), import('../src/services/queueService.js'), import('../src/socket/loungeGateway.js'),
    ]);
    const host = new mongoose.Types.ObjectId();
    const listener = new mongoose.Types.ObjectId();
    const outsider = new mongoose.Types.ObjectId();
    const loungeId = 'lg_950000000001';
    const secret = 'test-only-multi-instance-secret-at-least-32';
    await User.create([
      { _id: host, email: `${host}@example.invalid`, displayName: 'Multi Host', passwordHash: 'test-only-hash', role: 'Host' },
      { _id: listener, email: `${listener}@example.invalid`, displayName: 'Multi Listener', passwordHash: 'test-only-hash', role: 'Listener' },
      { _id: outsider, email: `${outsider}@example.invalid`, displayName: 'Other Lounge Host', passwordHash: 'test-only-hash', role: 'Host' },
    ]);
    await Track.create([
      { trackId: 't_9501', title: 'Current', artist: 'Fixture', durationSeconds: 180, acoustic: null, timeline: [] },
      { trackId: 't_9502', title: 'Added', artist: 'Fixture', durationSeconds: 180, acoustic: null, timeline: [] },
    ]);
    await DJLounge.create({ loungeId, inviteCode: 'SP-9X2N', hostUserId: host, vibeProfile: 'Gateway fixture', queue: ['t_9501'], currentTrackId: 't_9501', participantIds: [host, listener], status: 'live', settings: { maxParticipants: 8, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' } });
    await DJLounge.create({ loungeId: 'lg_950000000002', inviteCode: 'SP-9X2P', hostUserId: outsider, vibeProfile: 'Isolation fixture', queue: ['t_9501'], currentTrackId: 't_9501', participantIds: [outsider], status: 'live', settings: { maxParticipants: 8, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' } });
    const hostToken = jwt.sign({}, secret, { subject: String(host), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 300, algorithm: 'HS256' });
    const listenerToken = jwt.sign({}, secret, { subject: String(listener), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 300, algorithm: 'HS256' });
    const outsiderToken = jwt.sign({}, secret, { subject: String(outsider), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 300, algorithm: 'HS256' });
    const origins = [];
    for (let index = 0; index < 2; index += 1) {
      const httpServer = createServer();
      const ioServer = new SocketServer(httpServer, { transports: ['websocket'] });
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const port = httpServer.address().port;
      origins.push(`http://127.0.0.1:${port}`);
      const gateway = attachLoungeGateway(ioServer, { repository: queueRepository, queueService: createQueueService(queueRepository), secret, pollIntervalMs: 20 });
      servers.push(httpServer); gateways.push(gateway);
      const token = index === 0 ? hostToken : listenerToken;
      const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], auth: { token }, reconnection: false });
      clients.push(client);
      await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
      const joined = await socketCommand(client, 'lounge.join', { inviteCode: 'SP-9X2N' });
      expect(joined.ok).toBe(true);
    }
    const isolatedClient = createClient(origins[1], { transports: ['websocket'], auth: { token: outsiderToken }, reconnection: false });
    clients.push(isolatedClient);
    await new Promise((resolve, reject) => { isolatedClient.once('connect', resolve); isolatedClient.once('connect_error', reject); });
    expect((await socketCommand(isolatedClient, 'lounge.queue.add', { trackId: 't_9502' })).error.code).toBe('LOUNGE_MEMBERSHIP_REQUIRED');
    expect((await socketCommand(isolatedClient, 'lounge.join', { inviteCode: 'SP-9X2P' })).ok).toBe(true);
    const received = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Second gateway did not receive committed queue event')), 3000);
      clients[1].once('lounge.queue.update', (message) => { clearTimeout(timeout); resolve(message); });
    });
    let leaked = false;
    isolatedClient.on('lounge.queue.update', () => { leaked = true; });
    const result = await socketCommand(clients[0], 'lounge.queue.add', { trackId: 't_9502' });
    expect(result.ok).toBe(true);
    await expect(received).resolves.toMatchObject({ event: 'lounge.queue.update', loungeId, payload: { reason: 'add', queue: [{ trackId: 't_9501', position: 0 }, { trackId: 't_9502', position: 1 }] } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    isolatedClient.off('lounge.queue.update');
    expect(leaked).toBe(false);
  } finally {
    for (const client of clients) client.disconnect();
    for (const gateway of gateways) await gateway.close();
    for (const server of servers) if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 20000);
