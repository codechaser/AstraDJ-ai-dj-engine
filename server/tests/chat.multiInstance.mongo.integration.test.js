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
      AI_DJ_OUTRO_WINDOW_SECONDS: '12',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
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

async function stopGatewayProcess(worker) {
  if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const child = worker.child;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
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
  const timeout = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`Timed out waiting for ${event}`));
  }, 8000);
  const handler = (payload) => {
    if (!predicate(payload)) return;
    clearTimeout(timeout);
    socket.off(event, handler);
    resolve(payload);
  };
  socket.on(event, handler);
  return { promise, cancel() { clearTimeout(timeout); socket.off(event, handler); } };
}

liveTest('separate gateway processes deliver durable chat through the Mongo outbox and recover pending delivery', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'multinodechat');
  let connected = false;
  const workers = [];
  const clients = [];
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ DJLounge }, { User }, { ChatMessage }, { QueueEvent }, { queueRepository }, { createChatService }, { createRoomSentimentService }] = await Promise.all([
      import('../src/models/DJLounge.js'), import('../src/models/User.js'), import('../src/models/ChatMessage.js'),
      import('../src/models/QueueEvent.js'), import('../src/services/queueRepository.js'),
      import('../src/services/chatService.js'), import('../src/services/roomSentimentService.js'),
    ]);
    await Promise.all([ChatMessage.init(), QueueEvent.init()]);
    const userIds = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
    const [hostId, senderId, receiverId, outsiderId] = userIds;
    const loungeId = 'lg_951000000001';
    await DJLounge.create({
      loungeId, inviteCode: 'SP-9X2L', hostUserId: hostId, vibeProfile: 'Multi-process chat',
      queue: ['t_9401'], currentTrackId: 't_9401', status: 'live', participantIds: [hostId, senderId, receiverId],
      settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });
    await User.create(userIds.map((id, index) => ({
      _id: id, email: `${id}@example.invalid`, displayName: ['Host', 'Sender', 'Receiver', 'Outsider'][index],
      passwordHash: 'test-only-hash', role: index === 0 ? 'Host' : 'Listener',
    })));

    const projectionLoungeId = 'lg_951000000002';
    await DJLounge.create({
      loungeId: projectionLoungeId, inviteCode: 'SP-9X2M', hostUserId: hostId, vibeProfile: 'Outbox recovery',
      queue: ['t_9401'], currentTrackId: 't_9401', status: 'live', participantIds: [hostId, senderId],
      settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });
    const projectionService = createChatService({ repository: queueRepository, sentimentService: createRoomSentimentService() });
    const projectionClientMessageId = 'c23c23bd-2135-4e31-bfce-9ef3eb99769e';
    const originalFindOneAndUpdate = QueueEvent.findOneAndUpdate;
    let failProjection = true;
    QueueEvent.findOneAndUpdate = (...args) => {
      if (failProjection) {
        failProjection = false;
        return { lean: async () => { throw new Error('simulated QueueEvent projection failure'); } };
      }
      return originalFindOneAndUpdate.apply(QueueEvent, args);
    };
    try {
      await expect(projectionService.send({
        loungeId: projectionLoungeId, user: { id: String(senderId) },
        body: 'Amazing outbox projection recovery', clientMessageId: projectionClientMessageId,
      })).rejects.toMatchObject({ status: 503, code: 'CHAT_DELIVERY_UNAVAILABLE' });
    } finally {
      QueueEvent.findOneAndUpdate = originalFindOneAndUpdate;
    }
    expect(await ChatMessage.countDocuments({ loungeId: projectionLoungeId, clientMessageId: projectionClientMessageId })).toBe(1);
    expect(await QueueEvent.countDocuments({ loungeId: projectionLoungeId, type: 'chat.message' })).toBe(0);
    expect((await DJLounge.findOne({ loungeId: projectionLoungeId }).lean()).coordination.outbox).toHaveLength(1);
    expect(await projectionService.repairPendingDelivery(projectionLoungeId)).toBe(1);
    expect(await QueueEvent.countDocuments({ loungeId: projectionLoungeId, type: 'chat.message' })).toBe(1);
    expect((await DJLounge.findOne({ loungeId: projectionLoungeId }).lean()).coordination.outbox).toHaveLength(0);
    expect(await projectionService.repairPendingDelivery(projectionLoungeId)).toBe(0);
    expect(await QueueEvent.countDocuments({ loungeId: projectionLoungeId, type: 'chat.message' })).toBe(1);

    workers.push(startGatewayProcess(await reservePort(), uri), startGatewayProcess(await reservePort(), uri));
    await Promise.all(workers.map((worker) => worker.ready));
    const host = connectUser(workers[0].port, hostId);
    const sender = connectUser(workers[0].port, senderId);
    const receiver = connectUser(workers[1].port, receiverId);
    const outsider = connectUser(workers[1].port, outsiderId);
    const projectionMember = connectUser(workers[1].port, senderId);
    clients.push(host, sender, receiver, outsider, projectionMember);
    await Promise.all(clients.map(waitForConnect));
    expect((await command(host, 'lounge.join', { inviteCode: 'SP-9X2L' })).ok).toBe(true);
    expect((await command(sender, 'lounge.join', { inviteCode: 'SP-9X2L' })).ok).toBe(true);
    expect((await command(receiver, 'lounge.join', { inviteCode: 'SP-9X2L' })).ok).toBe(true);
    expect((await command(projectionMember, 'lounge.join', { inviteCode: 'SP-9X2M' })).ok).toBe(true);

    const crossProcessMessage = watchEvent(receiver, 'lounge.chat.message');
    const crossProcessSentiment = watchEvent(receiver, 'lounge.sentiment.score');
    const crossRoomLeaks = [];
    projectionMember.on('lounge.chat.message', (event) => {
      if (event.payload?.messageId === '95995a8f-91f7-46b4-bdc1-695a4afda511') crossRoomLeaks.push(event);
    });
    const clientMessageId = '95995a8f-91f7-46b4-bdc1-695a4afda511';
    const acknowledgement = await command(sender, 'lounge.chat.message', { body: 'Amazing across instances', clientMessageId });
    expect(acknowledgement).toMatchObject({ ok: true, message: { body: 'Amazing across instances' } });
    expect(await ChatMessage.countDocuments({ loungeId, clientMessageId })).toBe(1);
    const [delivered, sentiment] = await Promise.all([crossProcessMessage.promise, crossProcessSentiment.promise]);
    expect(delivered).toMatchObject({
      event: 'lounge.chat.message', loungeId,
      payload: { messageId: acknowledgement.message.messageId, body: 'Amazing across instances' },
    });
    expect(sentiment.payload).toMatchObject({ sampleSize: 1, rollingScore: 1 });
    expect(await QueueEvent.countDocuments({ loungeId, type: 'chat.message' })).toBe(1);
    expect(await ChatMessage.findOne({ loungeId, clientMessageId }).lean()).toMatchObject({ deliveryEventSeq: expect.any(Number) });
    const otherLoungeBarrier = watchEvent(projectionMember, 'lounge.chat.message', (event) => event.payload?.body === 'Other Lounge barrier');
    expect((await command(projectionMember, 'lounge.chat.message', {
      body: 'Other Lounge barrier', clientMessageId: '4bf9e989-4894-43c0-8d16-ef768fb8f46c',
    })).ok).toBe(true);
    await otherLoungeBarrier.promise;
    expect(crossRoomLeaks).toHaveLength(0);

    const retry = await command(sender, 'lounge.chat.message', { body: 'Amazing across instances', clientMessageId });
    expect(retry.message.messageId).toBe(acknowledgement.message.messageId);
    expect(await QueueEvent.countDocuments({ loungeId, type: 'chat.message' })).toBe(1);

    const secondClientMessageId = '6b2dc5ef-6303-4f66-9c4c-9c97ec7e3203';
    const interruptedService = createChatService({
      repository: {
        ...queueRepository,
        async ensureChatDeliveryEvent() { throw new Error('simulated server failure after Mongo persistence'); },
      },
      sentimentService: createRoomSentimentService(),
    });
    await expect(interruptedService.send({
      loungeId, user: { id: String(senderId) }, body: 'Amazing recovery after interruption',
      clientMessageId: secondClientMessageId,
    })).rejects.toMatchObject({ status: 503, code: 'CHAT_DELIVERY_UNAVAILABLE' });
    expect(await ChatMessage.countDocuments({ loungeId, clientMessageId: secondClientMessageId })).toBe(1);
    const recoveredDelivery = watchEvent(receiver, 'lounge.chat.message', (event) => event.payload?.body === 'Amazing recovery after interruption');
    const recovered = await recoveredDelivery.promise;
    expect(recovered.payload).toMatchObject({ body: 'Amazing recovery after interruption' });
    expect(await QueueEvent.countDocuments({ loungeId, type: 'chat.message' })).toBe(2);
    expect(await ChatMessage.findOne({ loungeId, clientMessageId: secondClientMessageId }).lean()).toMatchObject({ deliveryEventSeq: expect.any(Number) });

    expect((await command(outsider, 'lounge.chat.history', { limit: 10 })).error.code).toBe('LOUNGE_MEMBERSHIP_REQUIRED');
    expect((await command(outsider, 'lounge.chat.message', { body: 'not authorized' })).error.code).toBe('LOUNGE_MEMBERSHIP_REQUIRED');
    const history = await command(sender, 'lounge.chat.history', { limit: 10 });
    expect(history.messages.map((message) => message.messageId)).toEqual([
      acknowledgement.message.messageId,
      recovered.payload.messageId,
    ]);
    expect(history.sentiment).toMatchObject({ sampleSize: 2, rollingScore: 1 });
    const restartedService = createChatService({ repository: queueRepository, sentimentService: createRoomSentimentService() });
    expect(await restartedService.sentiment(loungeId)).toMatchObject({ sampleSize: 2, rollingScore: 1 });
  } finally {
    for (const client of clients) client.disconnect();
    await Promise.all(workers.map((worker) => stopGatewayProcess(worker)));
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 60000);
