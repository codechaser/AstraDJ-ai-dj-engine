import crypto from 'node:crypto';
import request from 'supertest';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('MongoDB persists audio preferences across logout/login and isolates them by account', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'preferences');
  process.env.MONGODB_URI = uri;
  process.env.JWT_ACCESS_SECRET = 'test-secret-astradj-only-32-characters';
  process.env.JWT_ACCESS_TTL_SECONDS = '900';
  let connected = false;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ app }, { User }] = await Promise.all([import('../src/app.js'), import('../src/models/User.js')]);
    const suffix = crypto.randomUUID().slice(0, 8);
    const first = request.agent(app);
    const second = request.agent(app);
    const firstEmail = `preferences-a-${suffix}@example.invalid`;
    const secondEmail = `preferences-b-${suffix}@example.invalid`;
    const password = 'test-password-1234';
    const firstRegistration = await first.post('/api/v1/auth/register').send({ email: firstEmail, displayName: 'Preference A', password });
    const secondRegistration = await second.post('/api/v1/auth/register').send({ email: secondEmail, displayName: 'Preference B', password });
    expect(firstRegistration.status).toBe(201);
    expect(secondRegistration.status).toBe(201);
    const firstToken = firstRegistration.body.accessToken;
    const updated = await first.patch('/api/v1/auth/me/preferences').set('Authorization', `Bearer ${firstToken}`).send({
      audio: { streamingQuality: 'Low (96 kbps)', crossfadeSeconds: 0, normalizeVolume: false, showLyrics: false, aiDjCommentary: false, downloadQuality: 'Normal', autoPlay: false },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.preferences.audio).toEqual({
      streamingQuality: 'Low (96 kbps)', crossfadeSeconds: 0, normalizeVolume: false, showLyrics: false,
      aiDjCommentary: false, downloadQuality: 'Normal', autoPlay: false,
    });
    const secondDefaults = await second.get('/api/v1/auth/me/preferences').set('Authorization', `Bearer ${secondRegistration.body.accessToken}`);
    expect(secondDefaults.body.preferences.audio).toMatchObject({ streamingQuality: 'High (320 kbps)', crossfadeSeconds: 6, autoPlay: true });

    await first.post('/api/v1/auth/logout');
    const login = await first.post('/api/v1/auth/login').send({ email: firstEmail, password });
    expect(login.status).toBe(200);
    const restored = await first.get('/api/v1/auth/me/preferences').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(restored.status).toBe(200);
    expect(restored.body.preferences.audio).toEqual(updated.body.preferences.audio);
    const storedFirst = await User.findById(firstRegistration.body.user.id).select('preferences');
    const storedSecond = await User.findById(secondRegistration.body.user.id).select('preferences');
    expect(storedFirst.preferences.audio.autoPlay).toBe(false);
    expect(storedSecond.preferences.audio.autoPlay).toBe(true);
    expect((await request(app).get('/api/v1/auth/me/preferences')).status).toBe(401);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 30000);
