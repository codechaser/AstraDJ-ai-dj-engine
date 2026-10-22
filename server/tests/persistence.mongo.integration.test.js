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
    const [{ app }, { User }, { RefreshToken }, { Track }, { Interaction }, { DJLounge }, { QueueEvent }, { ChatMessage }, { seedTracks }] = await Promise.all([
      import('../src/app.js'), import('../src/models/User.js'), import('../src/models/RefreshToken.js'),
      import('../src/models/Track.js'), import('../src/models/Interaction.js'), import('../src/models/DJLounge.js'),
      import('../src/models/QueueEvent.js'), import('../src/models/ChatMessage.js'), import('../src/seed/tracks.js'),
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

    const demoSeed = seedTracks.find(({ trackId }) => trackId === 't_cc0_thoughtness');
    expect(demoSeed).toMatchObject({ durationSeconds: 46, audioAssetUrl: '/audio/thoughtness.ogg', acoustic: null });
    const secondAudioSeed = seedTracks.find(({ trackId }) => trackId === 't_cc0_chill_beat');
    expect(secondAudioSeed).toMatchObject({ audioAssetUrl: '/audio/chill-beat.ogg', acoustic: null });
    await Track.create(demoSeed);
    await Track.create(secondAudioSeed);
    const catalogDemo = await request(app).get('/api/v1/tracks?q=Thoughtness');
    expect(catalogDemo.status).toBe(200);
    expect(catalogDemo.body.items).toContainEqual(expect.objectContaining({
      trackId: 't_cc0_thoughtness', audioAssetUrl: '/audio/thoughtness.ogg', durationSeconds: 46, acoustic: null,
    }));
    const catalogSecondAudio = await request(app).get('/api/v1/tracks?q=Chill%20Beat');
    expect(catalogSecondAudio.status).toBe(200);
    expect(catalogSecondAudio.body.items).toContainEqual(expect.objectContaining({
      trackId: 't_cc0_chill_beat', title: 'Chill Beat', artist: 'Maddy',
      audioAssetUrl: '/audio/chill-beat.ogg', durationSeconds: 96.180612244898, acoustic: null,
    }));
    const profileUnavailable = await request(app).get('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile');
    expect(profileUnavailable.status).toBe(409);
    expect(profileUnavailable.body.error.code).toBe('ACOUSTIC_PROFILE_UNAVAILABLE');

    const loungeId = `lg_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await DJLounge.create({
      loungeId, inviteCode: 'SP-ABCD', hostUserId: hostId,
      vibeProfile: 'Mongo test', queue: ['t_9101'], currentTrackId: 't_9101', participantIds: [hostId], status: 'live',
      startedAt: new Date(Date.now() - 10_000),
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

    const demoInteraction = await request(app).post('/api/v1/interactions')
      .set('Authorization', `Bearer ${hostLogin.body.accessToken}`)
      .send({ trackId: 't_cc0_thoughtness', playedSeconds: 46, completed: true, liked: false });
    expect(demoInteraction.status).toBe(201);
    const demoHistory = await request(app).get('/api/v1/dashboard/playback-history')
      .set('Authorization', `Bearer ${hostLogin.body.accessToken}`);
    expect(demoHistory.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ trackId: 't_cc0_thoughtness', completed: true, source: 'self_reported' }),
    ]));
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
    const outsiderHistory = await request(app).get('/api/v1/dashboard/playback-history')
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(outsiderHistory.status).toBe(200);
    expect(outsiderHistory.body.items).toEqual([]);
    expect(await Interaction.countDocuments({ userId: outsider._id, trackId: 't_cc0_thoughtness' })).toBe(0);
    const denied = await request(app).get(`/api/v1/dashboard/lounges/${loungeId}/analytics`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(denied.status).toBe(403);

    await User.findByIdAndUpdate(hostId, { role: 'Host' });
    const { loungeLifecycleService } = await import('../src/services/loungeLifecycleService.js');
    const firstEnd = await loungeLifecycleService.end({ loungeId, userId: hostId, userRole: 'Host' });
    const endRetry = await loungeLifecycleService.end({ loungeId, userId: hostId, userRole: 'Host' });
    expect(firstEnd.alreadyEnded).toBe(false);
    expect(endRetry.alreadyEnded).toBe(true);
    expect(firstEnd.lounge.sessionSummary).toMatchObject({ durationSeconds: expect.any(Number), queueEventCount: 2, soundclashBattles: 1, chatMessageCount: 1 });
    expect(await DJLounge.countDocuments({ loungeId, status: 'ended' })).toBe(1);
    const loungeHistory = await request(app).get('/api/v1/dashboard/lounge-history')
      .set('Authorization', `Bearer ${hostLogin.body.accessToken}`);
    expect(loungeHistory.status).toBe(200);
    expect(loungeHistory.body.items).toEqual([expect.objectContaining({ loungeId, role: 'Host', status: 'ended', summary: expect.objectContaining({ queueEventCount: 2, soundclashBattles: 1, chatMessageCount: 1 }) })]);
    expect(loungeHistory.body.items[0]).not.toHaveProperty('inviteCode');
    const outsiderLoungeHistory = await request(app).get('/api/v1/dashboard/lounge-history')
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(outsiderLoungeHistory.body.items).toEqual([]);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 30000);
