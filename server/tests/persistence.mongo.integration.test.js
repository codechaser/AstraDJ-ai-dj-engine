import crypto from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('MongoDB persists auth, catalog, interactions, queue events, and authorized Lounge analytics', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'persistence');
  process.env.MONGODB_URI = uri;
  process.env.JWT_ACCESS_SECRET = 'test-secret-astradj-only-32-characters';
  process.env.JWT_ACCESS_TTL_SECONDS = '900';
  let connected = false;

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ app }, { User }, { RefreshToken }, { Track }, { Interaction }, { DJLounge }, { QueueEvent }, { ChatMessage }] = await Promise.all([
      import('../src/app.js'), import('../src/models/User.js'), import('../src/models/RefreshToken.js'),
      import('../src/models/Track.js'), import('../src/models/Interaction.js'), import('../src/models/DJLounge.js'),
      import('../src/models/QueueEvent.js'), import('../src/models/ChatMessage.js'),
    ]);

    const suffix = crypto.randomUUID().slice(0, 8);
    const hostAgent = request.agent(app);
    const hostRegistration = await hostAgent.post('/api/v1/auth/register').send({
      email: `host-${suffix}@example.invalid`, displayName: 'Mongo Host', password: 'test-password-1234', role: 'Admin',
    });
    expect(hostRegistration.status).toBe(201);
    expect(hostRegistration.body.user.role).toBe('Listener');
    const hostLogin = await hostAgent.post('/api/v1/auth/login').send({
      email: `host-${suffix}@example.invalid`, password: 'test-password-1234',
    });
    expect(hostLogin.status).toBe(200);
    const hostId = hostLogin.body.user.id;
    const storedUser = await User.findById(hostId).select('+passwordHash');
    expect(storedUser).not.toBeNull();
    expect(storedUser.passwordHash).not.toBe('test-password-1234');
    expect(await RefreshToken.countDocuments({ userId: hostId })).toBeGreaterThanOrEqual(2);

    const track = await Track.create({
      trackId: 't_9101', title: 'Mongo Catalog Track', artist: 'Test Artist', durationSeconds: 120,
      acoustic: { bpm: 120, camelotKey: '8A', energy: 0.6, valence: 0.5 }, timeline: [],
    });
    expect(track.audioAssetUrl).toBeNull();
    const profile = await request(app).get('/api/v1/tracks/t_9101/acoustic-profile');
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ trackId: 't_9101', acoustic: { bpm: 120, camelotKey: '8A' } });

    const loungeId = `lg_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await DJLounge.create({
      loungeId, inviteCode: 'SP-ABCD', hostUserId: hostId,
      vibeProfile: 'Mongo test', queue: ['t_9101'], currentTrackId: 't_9101', participantIds: [hostId], status: 'live',
      settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });
    const interaction = await request(app).post('/api/v1/interactions')
      .set('Authorization', `Bearer ${hostLogin.body.accessToken}`)
      .send({ trackId: 't_9101', playedSeconds: 120, completed: true, liked: true, loungeId });
    expect(interaction.status).toBe(201);
    expect(await Interaction.countDocuments({ userId: hostId, trackId: 't_9101', source: 'self_reported' })).toBe(1);
    const history = await request(app).get('/api/v1/dashboard/playback-history')
      .set('Authorization', `Bearer ${hostLogin.body.accessToken}`);
    expect(history.status).toBe(200);
    expect(history.body.items).toMatchObject([{ trackId: 't_9101', completed: true, source: 'self_reported' }]);

    await QueueEvent.create([
      { loungeId, seq: 1, type: 'track.added', actorUserId: hostId, payload: { trackId: 't_9101' } },
      { loungeId, seq: 2, type: 'soundclash.opened', actorUserId: hostId, payload: { battleId: 'mongo-battle', candidateTrackIds: ['t_9101', 't_9102'] } },
    ]);
    await ChatMessage.create({
      messageId: crypto.randomUUID(), loungeId, userId: hostId, body: 'Mongo chat persisted',
      sentimentBucket: 'positive', sentimentScore: 0.8, tsSeconds: 12,
    });
    const analytics = await request(app).get(`/api/v1/dashboard/lounges/${loungeId}/analytics`)
      .set('Authorization', `Bearer ${hostLogin.body.accessToken}`);
    expect(analytics.status).toBe(200);
    expect(analytics.body).toMatchObject({ queueEventCount: 2, soundclashBattles: 1, chatMessageCount: 1, durationSeconds: null });
    expect(analytics.body.sentimentTimeline).toHaveLength(1);

    const outsider = await User.create({ email: `other-${suffix}@example.invalid`, displayName: 'Outsider', passwordHash: 'test-only-hash', role: 'Listener' });
    const outsiderToken = jwt.sign({}, process.env.JWT_ACCESS_SECRET, {
      subject: String(outsider._id), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256',
    });
    const denied = await request(app).get(`/api/v1/dashboard/lounges/${loungeId}/analytics`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(denied.status).toBe(403);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 30000);
