import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('Admin acoustic profile management persists catalog data consumed by the real segue matcher', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'acousticadmin');
  process.env.MONGODB_URI = uri;
  process.env.JWT_ACCESS_SECRET = 'test-secret-astradj-only-32-characters';
  process.env.JWT_ACCESS_TTL_SECONDS = '900';
  let connected = false;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ app }, { User }, { Track }, { DJLounge }, { createSegueService }] = await Promise.all([
      import('../src/app.js'), import('../src/models/User.js'), import('../src/models/Track.js'),
      import('../src/models/DJLounge.js'), import('../src/services/segueService.js'),
    ]);
    const suffix = crypto.randomUUID().slice(0, 8);
    const accounts = {};
    for (const role of ['Admin', 'Listener', 'Co-DJ', 'Host']) {
      const user = await User.create({ email: `${role}-${suffix}@example.invalid`, displayName: role, passwordHash: 'test-only-hash', role });
      accounts[role] = { id: String(user._id), token: jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: String(user._id), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' }) };
    }
    await Track.create([
      { trackId: 't_9401', title: 'Current Test Track', artist: 'Fixture Artist', durationSeconds: 180, acoustic: { bpm: 126, camelotKey: '8A', energy: 0.6, valence: 0.5 }, timeline: [] },
      { trackId: 't_9402', title: 'Unprofiled Test Track', artist: 'Fixture Artist', durationSeconds: 180, acoustic: null, timeline: [] },
      { trackId: 't_9403', title: 'Clashing Test Track', artist: 'Fixture Artist', durationSeconds: 180, acoustic: { bpm: 126, camelotKey: '3B', energy: 0.6, valence: 0.5 }, timeline: [] },
    ]);
    const loungeId = `lg_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await DJLounge.create({
      loungeId, inviteCode: 'SP-A2BC', hostUserId: accounts.Host.id, vibeProfile: 'Admin profile test',
      queue: ['t_9401'], currentTrackId: 't_9401', participantIds: [accounts.Host.id], status: 'live',
      settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: false, aiVerbosity: 'normal' },
    });

    const body = { acoustic: { bpm: 128, camelotKey: '9A', energy: 0.65, valence: 0.55 } };
    for (const role of ['Listener', 'Co-DJ', 'Host']) {
      const denied = await request(app).put('/api/v1/tracks/t_9402/acoustic-profile').set('Authorization', `Bearer ${accounts[role].token}`).send(body);
      expect(denied.status).toBe(403);
    }
    expect((await request(app).put('/api/v1/tracks/t_9402/acoustic-profile').send(body)).status).toBe(401);
    const saved = await request(app).put('/api/v1/tracks/t_9402/acoustic-profile').set('Authorization', `Bearer ${accounts.Admin.token}`).send(body);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ trackId: 't_9402', acoustic: body.acoustic });

    const catalog = await request(app).get('/api/v1/tracks?q=Unprofiled');
    expect(catalog.body.items).toContainEqual(expect.objectContaining({ trackId: 't_9402', acoustic: body.acoustic }));
    expect((await request(app).get('/api/v1/tracks/t_9402/acoustic-profile')).body.acoustic).toEqual(body.acoustic);

    const segue = await createSegueService({ loungeModel: DJLounge, trackModel: Track }).requestSegue({
      loungeId, userId: accounts.Host.id,
      input: { currentTrackId: 't_9401', currentTs: 20, candidateTrackIds: ['t_9402', 't_9403'], currentSentimentScore: 0.5 },
    });
    expect(segue.selectedTrackId).toBe('t_9402');
    expect(segue.matchReason).toMatchObject({ bpmRelation: 'direct', camelotRelation: 'adjacent' });
    expect(segue.selectedTrackId).not.toBe('t_9403');

    const invalidBodies = [
      { acoustic: { bpm: 0, camelotKey: '9A', energy: 0.65, valence: 0.55 } },
      { acoustic: { bpm: Infinity, camelotKey: '9A', energy: 0.65, valence: 0.55 } },
      { acoustic: { bpm: 128, camelotKey: '13A', energy: 0.65, valence: 0.55 } },
      { acoustic: { bpm: 128, camelotKey: '9A', energy: -0.1, valence: 0.55 } },
      { acoustic: { bpm: 128, camelotKey: '9A', energy: 0.65, valence: 1.1 } },
      { acoustic: { bpm: 128, camelotKey: '9A', energy: 0.65, valence: 0.55, extra: true } },
    ];
    for (const invalid of invalidBodies) {
      const response = await request(app).put('/api/v1/tracks/t_9402/acoustic-profile').set('Authorization', `Bearer ${accounts.Admin.token}`).send(invalid);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await Track.findOne({ trackId: 't_9402' }).lean()).acoustic).toEqual(body.acoustic);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 20000);
