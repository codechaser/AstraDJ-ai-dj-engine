import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('MongoDB session analytics exactly reconcile the durable log and remain Lounge-member scoped', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'sessionanalytics');
  process.env.MONGODB_URI = uri;
  process.env.JWT_ACCESS_SECRET = 'test-secret-astradj-only-32-characters';
  process.env.JWT_ACCESS_TTL_SECONDS = '900';
  let connected = false;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [
      { app }, { User }, { DJLounge }, { QueueEvent }, { ChatMessage }, { Track }, { LoungeMetricEvent },
      { createLoungeMetricEventService },
    ] = await Promise.all([
      import('../src/app.js'), import('../src/models/User.js'), import('../src/models/DJLounge.js'),
      import('../src/models/QueueEvent.js'), import('../src/models/ChatMessage.js'), import('../src/models/Track.js'),
      import('../src/models/LoungeMetricEvent.js'),
      import('../src/services/loungeMetricEventService.js'),
    ]);
    const suffix = crypto.randomUUID().slice(0, 8);
    const host = await User.create({ email: `analytics-host-${suffix}@example.invalid`, displayName: 'Analytics Host', passwordHash: 'test-only-hash', role: 'Host' });
    const guest = await User.create({ email: `analytics-guest-${suffix}@example.invalid`, displayName: 'Analytics Guest', passwordHash: 'test-only-hash', role: 'Listener' });
    const outsider = await User.create({ email: `analytics-outsider-${suffix}@example.invalid`, displayName: 'Analytics Outsider', passwordHash: 'test-only-hash', role: 'Listener' });
    const loungeId = `lg_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const inviteCode = 'SP-QWER';
    const start = new Date(Date.now() - 60_000);
    await DJLounge.create({
      loungeId, inviteCode, hostUserId: host._id, participantIds: [host._id, guest._id],
      vibeProfile: 'Analytics test', queue: ['t_2001'], currentTrackId: 't_2001', status: 'live',
      startedAt: start, analyticsTrackingVersion: 1,
      settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });

    let offset = 1_000;
    const metrics = createLoungeMetricEventService({ now: () => {
      const value = new Date(start.getTime() + offset);
      offset += 1_000;
      return value;
    } });
    // These are successful unique-user presence edges. Sequence order, not timestamp sorting, is authoritative.
    for (const [userId, action, count] of [
      [host._id, 'joined', 1], [guest._id, 'joined', 2], [host._id, 'left', 1],
      [guest._id, 'left', 0], [host._id, 'joined', 1],
    ]) {
      await metrics.recordPresence({ loungeId, userId, action, participantCount: count });
    }
    await Track.create({
      trackId: 't_2001', title: 'Night Drive', artist: 'Nova Circuit', durationSeconds: 220,
      acoustic: { bpm: 124, camelotKey: '8A', energy: 0.78, valence: 0.65 }, timeline: [],
    });
    const tokenFor = (user) => jwt.sign({}, process.env.JWT_ACCESS_SECRET, {
      subject: String(user._id), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256',
    });
    const guestToken = tokenFor(guest);
    const hostToken = tokenFor(host);
    const outsiderToken = tokenFor(outsider);
    const ask = (userToken, requestId, question) => request(app).post(`/api/v1/lounges/${loungeId}/ai/ask`)
      .set('Authorization', `Bearer ${userToken}`).set('Idempotency-Key', requestId).send({ question });
    const firstQuestion = await ask(guestToken, 'analytics-request-0001', 'What is the BPM?');
    expect(firstQuestion.status).toBe(200);
    expect(firstQuestion.body).toMatchObject({ grounded: true, sourceEvents: ['t_2001#acoustic.bpm'] });
    expect((await ask(guestToken, 'analytics-request-0001', 'What is the BPM?')).status).toBe(200); // retry: one durable row
    expect((await ask(hostToken, 'analytics-request-0002', 'What are the lyrics about?')).body).toMatchObject({ grounded: false, sourceEvents: [] });
    expect((await ask(outsiderToken, 'analytics-request-0003', 'What is the BPM?')).status).toBe(403);

    const endedAt = new Date();
    await QueueEvent.create([
      { loungeId, seq: 1, type: 'track.added', actorUserId: host._id, payload: { trackId: 't_2002' }, createdAt: new Date(start.getTime() + 1_000) },
      { loungeId, seq: 2, type: 'soundclash.opened', actorUserId: host._id, payload: { battleId: 'verified-battle-1' }, createdAt: new Date(start.getTime() + 8_000) },
      { loungeId, seq: 3, type: 'soundclash.opened', actorUserId: host._id, payload: { battleId: 'verified-battle-1' }, createdAt: new Date(start.getTime() + 9_000) },
      { loungeId, seq: 4, type: 'soundclash.resolved', actorUserId: host._id, payload: { battleId: 'verified-battle-1', winningTrackId: 't_2002' }, createdAt: new Date(start.getTime() + 10_000) },
    ]);
    await ChatMessage.create([
      { messageId: crypto.randomUUID(), loungeId, userId: guest._id, body: 'This feels rough', sentimentBucket: 'negative', sentimentScore: 0.2, tsSeconds: 15, createdAt: new Date(start.getTime() + 15_000) },
      { messageId: crypto.randomUUID(), loungeId, userId: host._id, body: 'Settling in', sentimentBucket: 'neutral', sentimentScore: 0.5, tsSeconds: 25, createdAt: new Date(start.getTime() + 25_000) },
      { messageId: crypto.randomUUID(), loungeId, userId: guest._id, body: 'Great energy now', sentimentBucket: 'positive', sentimentScore: 0.9, tsSeconds: 35, createdAt: new Date(start.getTime() + 35_000) },
    ]);

    const { createLoungeLifecycleService } = await import('../src/services/loungeLifecycleService.js');
    const lifecycle = createLoungeLifecycleService({ now: () => endedAt });
    const ended = await lifecycle.end({ loungeId, userId: String(host._id), userRole: 'Host' });
    const expected = {
      durationSeconds: Math.floor((endedAt.getTime() - start.getTime()) / 1000), queueEventCount: 4, soundclashBattles: 1, chatMessageCount: 3,
      sentimentTimeline: [
        { at: new Date(start.getTime() + 15_000).toISOString(), score: 0.2, bucket: 'negative' },
        { at: new Date(start.getTime() + 25_000).toISOString(), score: 0.5, bucket: 'neutral' },
        { at: new Date(start.getTime() + 35_000).toISOString(), score: 0.9, bucket: 'positive' },
      ],
      peakConcurrentParticipants: 2, aiDjQuestionCount: 2, unavailableMetrics: {},
    };
    expect(ended.lounge.sessionSummary).toEqual(expected);
    expect(await QueueEvent.countDocuments({ loungeId })).toBe(4);
    const persistedMetricEvents = await LoungeMetricEvent.find({ loungeId }).sort({ seq: 1 }).lean();
    expect(persistedMetricEvents.map((event) => ({ seq: event.seq, type: event.type, requestId: event.requestId }))).toEqual([
      { seq: 1, type: 'participant.joined', requestId: null },
      { seq: 2, type: 'participant.joined', requestId: null },
      { seq: 3, type: 'participant.left', requestId: null },
      { seq: 4, type: 'participant.left', requestId: null },
      { seq: 5, type: 'participant.joined', requestId: null },
      { seq: 6, type: 'ai.question.asked', requestId: 'analytics-request-0001' },
      { seq: 7, type: 'ai.question.asked', requestId: 'analytics-request-0002' },
    ]);
    expect(persistedMetricEvents.every((event) => !Object.hasOwn(event, 'question'))).toBe(true);

    const analyticsResponse = await request(app).get(`/api/v1/dashboard/lounges/${loungeId}/analytics`).set('Authorization', `Bearer ${hostToken}`);
    expect(analyticsResponse.status).toBe(200);
    expect(analyticsResponse.body).toMatchObject({ loungeId, ...expected });
    expect(JSON.stringify(analyticsResponse.body)).not.toMatch(/inviteCode|participantIds|userId|requestId|body/);
    const historyResponse = await request(app).get('/api/v1/dashboard/lounge-history').set('Authorization', `Bearer ${hostToken}`);
    expect(historyResponse.status).toBe(200);
    expect(historyResponse.body.items[0].summary).toEqual(expected);
    expect((await request(app).get(`/api/v1/dashboard/lounges/${loungeId}/analytics`).set('Authorization', `Bearer ${outsiderToken}`)).status).toBe(403);
    expect((await request(app).get('/api/v1/dashboard/lounge-history').set('Authorization', `Bearer ${outsiderToken}`)).body.items).toEqual([]);
    expect((await lifecycle.end({ loungeId, userId: String(host._id), userRole: 'Host' })).lounge.sessionSummary).toEqual(expected);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 30000);
