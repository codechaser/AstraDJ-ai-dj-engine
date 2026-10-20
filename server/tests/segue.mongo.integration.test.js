import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('live MongoDB segue endpoint loads persisted profiles, authorizes membership, and returns grounded output', async () => {
  const mongoose = (await import('mongoose')).default;
  const userId = new mongoose.Types.ObjectId();
  const { uri: isolatedUri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'segue');
  process.env.MONGODB_URI = isolatedUri;
  process.env.JWT_ACCESS_SECRET = 'test-secret-astradj-only-32-characters';
  process.env.JWT_ACCESS_TTL_SECONDS = '900';
  let connected = false;

  try {
    await mongoose.connect(isolatedUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ app }, { User }, { Track }, { DJLounge }] = await Promise.all([
      import('../src/app.js'), import('../src/models/User.js'), import('../src/models/Track.js'), import('../src/models/DJLounge.js'),
    ]);
    await User.create({ _id: userId, email: `${userId}@example.invalid`, displayName: 'Mongo Test Host', passwordHash: 'test-only-hash', role: 'Host' });
    await Track.create([
      { trackId: 't_9001', title: 'Mongo Current', artist: 'Test Artist', durationSeconds: 220, acoustic: { bpm: 120, camelotKey: '8A', energy: 0.6, valence: 0.5 }, timeline: [] },
      { trackId: 't_9002', title: 'Mongo Follow-up', artist: 'Test Artist', durationSeconds: 210, acoustic: { bpm: 124, camelotKey: '9A', energy: 0.65, valence: 0.55 }, timeline: [{ ts: 14, type: 'trivia', text: 'A synthetic fact for the Mongo-backed test.' }] },
    ]);
    await DJLounge.create({
      loungeId: 'lg_900000000001', inviteCode: 'SP-9X2L', hostUserId: userId, vibeProfile: 'Test',
      queue: ['t_9001'], currentTrackId: 't_9001', participantIds: [userId], status: 'live',
      settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: false, aiVerbosity: 'normal' },
    });
    const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: String(userId), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
    const response = await request(app).post('/api/v1/lounges/lg_900000000001/ai/segue')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentTrackId: 't_9001', currentTs: 198, candidateTrackIds: ['t_9002'], currentSentimentScore: 0.7 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ selectedTrackId: 't_9002', provider: 'deterministic_fallback' });
    expect(response.body.sourceEvents).toContain('t_9002#timeline[0]');
  } finally {
    if (connected) {
      await dropIsolatedMongoTestDatabase(mongoose, databaseName);
    }
  }
}, 15000);
